import { Suspense } from "react";
import { songs, getSong, getLatestTake } from "@/lib/mock/data";
import RecordView from "@/components/RecordView";

export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const song = getSong(songId ?? "") ?? songs[0];

  return (
    <Suspense>
      <RecordView songs={songs} song={song} latestTake={getLatestTake(song.id)} />
    </Suspense>
  );
}
