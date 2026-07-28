import { notFound } from "next/navigation";
import { getTake, getSong, getTakesForSong, takes } from "@/lib/mock/data";
import TakeAnalysisView from "@/components/TakeAnalysisView";
import { redirect } from "next/navigation";

export function generateStaticParams() {
  return takes.map((t) => ({ id: t.id }));
}

export default async function TakePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id.startsWith("take_")) redirect(`/takes/real/${id}`);
  const take = getTake(id);
  if (!take) notFound();
  const song = getSong(take.songId);
  if (!song) notFound();

  const list = getTakesForSong(take.songId);
  const idx = list.findIndex((t) => t.id === take.id);
  const prev = idx > 0 ? list[idx - 1] : undefined;

  return <TakeAnalysisView song={song} take={take} prev={prev} first={list[0]} />;
}
