import { Suspense } from "react";
import { notFound } from "next/navigation";
import { songs, getSong, getTakesForSong, findStagnantMeasures } from "@/lib/mock/data";
import ProgressView from "@/components/ProgressView";

export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const song = getSong(songId ?? "") ?? songs[0];
  const takes = getTakesForSong(song.id);
  if (takes.length === 0) notFound();

  return (
    <Suspense>
      <ProgressView
        songs={songs}
        song={song}
        takes={takes}
        stagnant={findStagnantMeasures(song.id)}
      />
    </Suspense>
  );
}
