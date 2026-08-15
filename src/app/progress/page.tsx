import { Suspense } from "react";
import { notFound } from "next/navigation";
import { songs, getSong, getTakesForSong, findStagnantMeasures } from "@/lib/mock/data";
import ProgressView from "@/components/ProgressView";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, sortByRecordedAtDesc } from "@/lib/real-history";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import { PageHeader } from "@/components/ui";
import SongSelector from "@/components/SongSelector";

export default async function ProgressPage({
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

  const realSong = selectedId.startsWith("song_") ? await getRealSong(selectedId) : null;
  if (realSong) {
    const takes = await listTakesBySong(selectedId);
    if (takes.length === 0) notFound();

    const ordered = sortByRecordedAtDesc(takes);

    return (
      <div>
        <PageHeader
          title={`テイク一覧 — ${realSong.title}`}
          description="録音したテイクを新しい順に一覧表示し、それぞれの採点結果を示します。判定保留のテイクは理由を表示します。"
        />
        <Suspense>
          <SongSelector songs={selectableSongs} current={selectedId} />
        </Suspense>
        <div className="mt-5 space-y-6">
          {ordered.map((take) => (
            <section key={take.id}>
              <h2 className="mb-2 text-sm font-semibold">
                {take.label} ・ {new Date(take.recordedAt).toLocaleString("ja-JP")}
              </h2>
              <TakeEvaluationPanel take={take} />
            </section>
          ))}
        </div>
      </div>
    );
  }

  const song = getSong(selectedId) ?? songs[0];
  const takes = getTakesForSong(song.id);
  if (takes.length === 0) notFound();

  return (
    <Suspense>
      <ProgressView
        songs={selectableSongs}
        song={song}
        takes={takes}
        stagnant={findStagnantMeasures(song.id)}
      />
    </Suspense>
  );
}
