import { Suspense } from "react";
import {
  songs,
  getSong,
  getLatestTake,
  coachChatSeed,
  findStagnantMeasures,
} from "@/lib/mock/data";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, toCoachTake } from "@/lib/real-history";
import CoachView from "@/components/CoachView";
import SongSelector from "@/components/SongSelector";
import EmptyTakesNotice from "@/components/EmptyTakesNotice";
import { guidanceForNoSongs, guidanceForNoTakes, type EmptyTakesGuidance } from "@/components/empty-takes";
import { PageHeader } from "@/components/ui";
import type { Song } from "@/lib/mock/types";

// AIコーチは最新テイクの分析を前提にした画面なので、テイクが無いときは CoachView を
// 描けない（`take` を必須で受け取る）。実データをモック用コンポーネントに流さない
// という原則もあるため、空状態は専用の枠で見せる。曲セレクタは残して、録音済みの
// 別の曲へ移動できるようにする（#34）。
function CoachEmptyState({
  guidance,
  selectableSongs,
  currentSongId,
  title,
}: {
  guidance: EmptyTakesGuidance;
  selectableSongs: Song[];
  currentSongId?: string;
  title: string;
}) {
  return (
    <div>
      <PageHeader title={title} description="録音した演奏の分析結果をもとに、練習の相談ができます。" />
      {currentSongId && (
        <Suspense>
          <SongSelector songs={selectableSongs} current={currentSongId} />
        </Suspense>
      )}
      <EmptyTakesNotice guidance={guidance} />
    </div>
  );
}

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const realSongs = await listRealSongs();
  const selectableSongs = [...realSongs.map(toHistorySong), ...songs];
  const selectedId = songId && selectableSongs.some((candidate) => candidate.id === songId)
    ? songId
    : selectableSongs[0]?.id;

  if (!selectedId) {
    return (
      <CoachEmptyState
        guidance={guidanceForNoSongs()}
        selectableSongs={selectableSongs}
        title="AIコーチ"
      />
    );
  }

  if (selectedId.startsWith("song_")) {
    const realSong = await getRealSong(selectedId);
    const takes = realSong ? (await listTakesBySong(selectedId)).map(toCoachTake) : [];
    if (!realSong || takes.length === 0) {
      return (
        <CoachEmptyState
          guidance={realSong ? guidanceForNoTakes(realSong) : guidanceForNoSongs()}
          selectableSongs={selectableSongs}
          currentSongId={realSong ? selectedId : undefined}
          title={realSong ? `AIコーチ — ${realSong.title}` : "AIコーチ"}
        />
      );
    }

    const song = toHistorySong(realSong);
    const take = takes[takes.length - 1];
    const seed = [
      {
        id: "cm-generic",
        role: "assistant" as const,
        body: `${song.title} の最新テイクを分析しました。気になっている箇所を教えてください。分析データを見ながら一緒に考えます。`,
      },
    ];

    return (
      <Suspense>
        <CoachView
          songs={selectableSongs}
          song={song}
          take={take}
          seed={seed}
          stagnant={[]}
        />
      </Suspense>
    );
  }

  const song = getSong(selectedId) ?? songs[0];
  const take = getLatestTake(song.id);
  // 現在のデモ曲は4曲すべてテイクを持つのでここには来ないが、テイクの無いデモ曲を
  // 足した日に 404 が復活しないよう、実データ経路と同じ空状態に揃えておく。
  if (!take) {
    return (
      <CoachEmptyState
        guidance={guidanceForNoTakes({ id: song.id })}
        selectableSongs={selectableSongs}
        currentSongId={song.id}
        title={`AIコーチ — ${song.title}`}
      />
    );
  }

  const seed =
    song.id === songs[0].id
      ? coachChatSeed
      : [
          {
            id: "cm-generic",
            role: "assistant" as const,
            body: `${song.title} の最新テイクを分析しました。気になっている箇所を教えてください。分析データを見ながら一緒に考えます。`,
          },
        ];

  return (
    <Suspense>
      <CoachView
        songs={selectableSongs}
        song={song}
        take={take}
        seed={seed}
        stagnant={findStagnantMeasures(song.id)}
      />
    </Suspense>
  );
}
