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
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, toHistoryTake } from "@/lib/real-history";
import { getAccountContextForLayout } from "@/lib/server/account";

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const realSongs = await listRealSongs();
  const account = await getAccountContextForLayout();
  const selectableSongs = [...realSongs.map(toHistorySong), ...songs];
  const selectedId = songId && selectableSongs.some((candidate) => candidate.id === songId)
    ? songId
    : selectableSongs[0]?.id;

  if (!selectedId) notFound();

  if (selectedId.startsWith("song_")) {
    const realSong = await getRealSong(selectedId);
    const takes = realSong ? (await listTakesBySong(selectedId)).map(toHistoryTake) : [];
    if (!realSong || takes.length === 0) notFound();

    return (
      <Suspense>
        <ShareView
          songs={selectableSongs}
          song={toHistorySong(realSong)}
          takes={takes}
          comments={[]}
          assignments={[]}
          viewerDisplayName={account?.profile.displayName}
          classroomName={account?.activeClassroom?.name}
        />
      </Suspense>
    );
  }

  const song = getSong(selectedId) ?? songs[0];
  const takes = getTakesForSong(song.id);
  if (takes.length === 0) notFound();

  return (
    <Suspense>
      <ShareView
        songs={selectableSongs}
        song={song}
        takes={takes}
        comments={getCommentsForSong(song.id)}
        assignments={getAssignmentsForSong(song.id)}
        viewerDisplayName={account?.profile.displayName}
        classroomName={account?.activeClassroom?.name}
      />
    </Suspense>
  );
}
