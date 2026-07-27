import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  songs,
  getSong,
  getTakesForSong,
  getCommentsForSong,
  getAssignmentsForSong,
} from "@/lib/mock/data";
import ShareView from "@/components/ShareView";

export default async function SharePage({
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
      <ShareView
        songs={songs}
        song={song}
        takes={takes}
        comments={getCommentsForSong(song.id)}
        assignments={getAssignmentsForSong(song.id)}
      />
    </Suspense>
  );
}
