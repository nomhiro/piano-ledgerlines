import Link from "next/link";
import { getAuthenticatedServerUser } from "@/lib/server/auth";
import { getAccountContextForLayout } from "@/lib/server/account";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { ForbiddenError, NotFoundError } from "@/lib/server/http";
import { getRepository, getSong, listTakesBySong } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

async function loadSong(studentId: string, songId: string) {
  const user = await getAuthenticatedServerUser();
  const account = await getAccountContextForLayout();
  const classroomId = account?.activeClassroom?.id;
  if (!classroomId) throw new NotFoundError("classroom not found");
  await assertTeacherCanAccessStudent(classroomId, user.id, studentId, getRepository());
  const song = await getSong(songId, studentId);
  if (!song) throw new NotFoundError("song not found");
  return { song, takes: await listTakesBySong(songId, studentId) };
}

export default async function ClassroomStudentSongPage({
  params,
}: { params: Promise<{ studentId: string; songId: string }> }) {
  const { studentId, songId } = await params;
  let data;
  try {
    data = await loadSong(studentId, songId);
  } catch (error) {
    if (error instanceof ForbiddenError) return <SafeError message="この曲を表示する権限がありません。" />;
    if (error instanceof NotFoundError) return <SafeError message="曲または教室が見つかりません。" />;
    return <SafeError message="曲の情報を読み込めませんでした。" />;
  }
  const { song, takes } = data;
  return (
    <div className="space-y-5">
      <header>
        <Link href={`/classroom/students/${encodeURIComponent(studentId)}`} className="text-xs text-violet-300 hover:underline">← 生徒の曲一覧</Link>
        <h1 className="mt-3 text-2xl font-bold">{song.title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{song.composer} ・ 読み取り専用</p>
      </header>
      <section className="grid gap-3 sm:grid-cols-3">
        <Metric label="状態" value={song.status} />
        <Metric label="小節数" value={song.measureCount === null ? "未解析" : `${song.measureCount}小節`} />
        <Metric label="録音" value={`${takes.length}テイク`} />
      </section>
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <h2 className="border-b border-[var(--border)] p-4 font-semibold">録音履歴</h2>
        <div className="divide-y divide-[var(--border)]">
          {takes.map((take) => <div key={take.id} className="flex justify-between p-4 text-sm"><span>{take.label}</span><span className="text-xs text-[var(--muted)]">{take.status} ・ {take.overallScore === null ? "スコア未算出" : `${take.overallScore}点`}</span></div>)}
          {takes.length === 0 && <p className="p-4 text-sm text-[var(--muted)]">録音はありません。</p>}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-xs text-[var(--muted)]">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>;
}
function SafeError({ message }: { message: string }) {
  return <div className="space-y-3"><h1 className="text-xl font-semibold">表示できません</h1><p className="text-sm text-[var(--muted)]">{message}</p><Link href="/classroom" className="text-sm text-violet-300 hover:underline">教室へ戻る</Link></div>;
}
