import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  songs,
  getSong,
  getLatestTake,
  coachChatSeed,
  findStagnantMeasures,
} from "@/lib/mock/data";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, toHistoryTake } from "@/lib/real-history";
import CoachView from "@/components/CoachView";

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

  if (!selectedId) notFound();

  if (selectedId.startsWith("song_")) {
    const realSong = await getRealSong(selectedId);
    const takes = realSong ? (await listTakesBySong(selectedId)).map(toHistoryTake) : [];
    if (!realSong || takes.length === 0) notFound();

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
  if (!take) notFound();

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
