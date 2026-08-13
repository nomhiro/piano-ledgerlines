import { Suspense } from "react";
import { notFound } from "next/navigation";
import { songs, getSong, getTakesForSong, findStagnantMeasures } from "@/lib/mock/data";
import ProgressView from "@/components/ProgressView";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, toHistoryTake } from "@/lib/real-history";

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
    const takes = (await listTakesBySong(selectedId)).map(toHistoryTake);
    if (takes.length === 0) notFound();

    return (
      <Suspense>
        <ProgressView
          songs={selectableSongs}
          song={toHistorySong(realSong)}
          takes={takes}
          stagnant={[]}
        />
      </Suspense>
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
