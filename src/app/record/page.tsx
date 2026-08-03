import { Suspense } from "react";
import { songs, getLatestTake } from "@/lib/mock/data";
import { getSong as getRealSong, listSongs as listRealSongs } from "@/lib/server/repository";
import RecordView from "@/components/RecordView";
import type { Song } from "@/lib/mock/types";
import type { SongDoc } from "@/lib/server/types";

function toRecordSong(song: SongDoc): Song {
  return {
    id: song.id,
    title: song.title,
    composer: song.composer,
    period: "",
    keySignature: song.keySignature ?? "不明",
    timeSignature: song.timeSignature ?? "不明",
    difficulty: 0,
    totalMeasures: song.measureCount ?? 0,
    scoreUrl: null,
    accent: "#8b5cf6",
    status: "practicing",
    goalDate: null,
    goalDescription: null,
    addedAt: song.createdAt,
    targetTempo: song.targetTempo ?? song.detectedTempo ?? 120,
    currentTempo: song.detectedTempo ?? song.targetTempo ?? 120,
    sharedWithTeacher: false,
  };
}

export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const realSongs = (await listRealSongs())
    .filter((song) => song.status === "ready")
    .map(toRecordSong);
  const selectableSongs = [...realSongs, ...songs];

  // song_ で始まるIDは実バックエンド(src/lib/server)で作成された実データ。
  // それ以外は src/lib/mock のダミーカタログとして扱う。
  if (songId?.startsWith("song_")) {
    const realSong = await getRealSong(songId);
    if (realSong?.status === "ready") {
      return (
        <Suspense>
          <RecordView songs={selectableSongs} song={toRecordSong(realSong)} latestTake={undefined} real />
        </Suspense>
      );
    }
  }

  const song = selectableSongs.find((candidate) => candidate.id === songId) ?? selectableSongs[0];

  return (
    <Suspense>
      <RecordView
        songs={selectableSongs}
        song={song}
        latestTake={song.id.startsWith("song_") ? undefined : getLatestTake(song.id)}
        real={song.id.startsWith("song_")}
      />
    </Suspense>
  );
}
