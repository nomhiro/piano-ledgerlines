import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  songs,
  getSong,
  getLatestTake,
  coachChatSeed,
  findStagnantMeasures,
} from "@/lib/mock/data";
import CoachView from "@/components/CoachView";

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const song = getSong(songId ?? "") ?? songs[0];
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
        songs={songs}
        song={song}
        take={take}
        seed={seed}
        stagnant={findStagnantMeasures(song.id)}
      />
    </Suspense>
  );
}
