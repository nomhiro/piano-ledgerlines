import { Suspense } from "react";
import { songs, getSong, getLatestTake } from "@/lib/mock/data";
import { getSong as getRealSong } from "@/lib/server/repository";
import RecordView from "@/components/RecordView";
import type { Song } from "@/lib/mock/types";

export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;

  // song_ で始まるIDは実バックエンド(src/lib/server)で作成された実データ。
  // それ以外は src/lib/mock のダミーカタログとして扱う。
  if (songId?.startsWith("song_")) {
    const realSong = await getRealSong(songId);
    if (realSong) {
      const asMockShape: Song = {
        id: realSong.id,
        title: realSong.title,
        composer: realSong.composer,
        period: "",
        keySignature: realSong.keySignature ?? "不明",
        timeSignature: realSong.timeSignature ?? "不明",
        difficulty: 0,
        totalMeasures: realSong.measureCount ?? 0,
        scoreUrl: null,
        accent: "#8b5cf6",
        status: "practicing",
        goalDate: null,
        goalDescription: null,
        addedAt: realSong.createdAt,
        targetTempo: realSong.targetTempo ?? realSong.detectedTempo ?? 120,
        currentTempo: realSong.detectedTempo ?? realSong.targetTempo ?? 120,
        sharedWithTeacher: false,
      };
      return (
        <Suspense>
          <RecordView songs={songs} song={asMockShape} latestTake={undefined} real />
        </Suspense>
      );
    }
  }

  const song = getSong(songId ?? "") ?? songs[0];

  return (
    <Suspense>
      <RecordView songs={songs} song={song} latestTake={getLatestTake(song.id)} />
    </Suspense>
  );
}
