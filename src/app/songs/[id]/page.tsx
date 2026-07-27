import { notFound } from "next/navigation";
import { getSong, getTakesForSong, findStagnantMeasures, songs } from "@/lib/mock/data";
import SongDetailView from "@/components/SongDetailView";

export function generateStaticParams() {
  return songs.map((s) => ({ id: s.id }));
}

export default async function SongDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const song = getSong(id);
  const takes = getTakesForSong(id);
  if (!song || takes.length === 0) notFound();

  return (
    <SongDetailView song={song} takes={takes} stagnant={findStagnantMeasures(id)} />
  );
}
