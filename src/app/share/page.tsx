import { Suspense } from "react";
import { listSongs as listRealSongs, getSong as getRealSong, listTakesBySong } from "@/lib/server/repository";
import { toHistorySong, sortByRecordedAtDesc } from "@/lib/real-history";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import SongSelector from "@/components/SongSelector";
import { getAccountContextForLayout } from "@/lib/server/account";

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ song?: string }>;
}) {
  const { song: songId } = await searchParams;
  const realSongs = await listRealSongs();
  const account = await getAccountContextForLayout();
  const selectableSongs = realSongs.map(toHistorySong);
  const selectedId = songId && selectableSongs.some((candidate) => candidate.id === songId)
    ? songId
    : selectableSongs[0]?.id;

  if (!selectedId) {
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-2xl font-bold">先生と共有</h1>
        <p className="text-sm text-[var(--muted)]">
          共有できる録音済みの曲がありません。曲を登録して録音すると、共有設定を確認できます。
        </p>
        <p className="text-sm text-[var(--muted)]">
          {account?.activeClassroom ? "教室の共有先が設定されていません。" : "共有先未設定（個人利用）"}
        </p>
      </div>
    );
  }

  if (selectedId.startsWith("song_")) {
    const realSong = await getRealSong(selectedId);
    const takes = realSong ? await listTakesBySong(selectedId) : [];
    if (!realSong || takes.length === 0) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-bold">共有できません</h1>
          <p className="text-sm text-[var(--muted)]">曲または録音が見つかりません。</p>
        </div>
      );
    }

    const latest = sortByRecordedAtDesc(takes)[0];

    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{realSong.title} の共有</h1>
        {/* SongSelector は "use client" で useSearchParams を呼ぶため Suspense が必須
            （境界が無いと本番ビルドが失敗する）。/progress と同じ形を保つ。 */}
        <Suspense>
          <SongSelector songs={selectableSongs} current={selectedId} />
        </Suspense>
        <p className="text-sm text-[var(--muted)]">
          {account?.activeClassroom
            ? `共有先: ${account.activeClassroom.name}`
            : "共有先未設定（個人利用）"}
        </p>
        <TakeEvaluationPanel take={latest} />
      </div>
    );
  }

  return <p className="text-sm text-[var(--muted)]">曲を読み込めませんでした。</p>;
}
