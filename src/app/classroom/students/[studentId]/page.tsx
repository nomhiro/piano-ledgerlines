import Link from "next/link";
import { getAuthenticatedServerUser } from "@/lib/server/auth";
import { getAccountContextForLayout } from "@/lib/server/account";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { ForbiddenError, NotFoundError } from "@/lib/server/http";
import { getRepository, listSongTakeSummaries, listSongs } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

async function loadStudent(studentId: string) {
  const user = await getAuthenticatedServerUser();
  const account = await getAccountContextForLayout();
  const classroomId = account?.activeClassroom?.id;
  if (!classroomId) throw new NotFoundError("classroom not found");
  const access = await assertTeacherCanAccessStudent(classroomId, user.id, studentId, getRepository());
  const songs = await listSongs(studentId);
  return {
    classroomName: access.classroom.name,
    songs,
    summaries: await listSongTakeSummaries(songs.map((song) => song.id), studentId),
  };
}

export default async function ClassroomStudentPage({
  params,
}: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  let data;
  try {
    data = await loadStudent(studentId);
  } catch (error) {
    if (error instanceof ForbiddenError) return <SafeError message="この生徒の情報を表示する権限がありません。" />;
    if (error instanceof NotFoundError) return <SafeError message="生徒または教室が見つかりません。" />;
    return <SafeError message="生徒の情報を読み込めませんでした。" />;
  }
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs text-[var(--muted)]">{data.classroomName} / 生徒</p>
        <h1 className="text-2xl font-bold">生徒の練習状況</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">この画面は読み取り専用です。</p>
      </header>
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] p-4 font-semibold">曲</div>
        <div className="divide-y divide-[var(--border)]">
          {data.songs.map((song) => (
            <Link key={song.id} href={`/classroom/students/${encodeURIComponent(studentId)}/songs/${encodeURIComponent(song.id)}`} className="flex items-center justify-between p-4 hover:bg-[var(--surface-2)]">
              <span><span className="text-sm">{song.title}</span><span className="ml-2 text-xs text-[var(--muted)]">{song.composer}</span></span>
              <span className="text-xs text-[var(--muted)]">{data.summaries[song.id]?.count ?? 0}テイクを見る →</span>
            </Link>
          ))}
          {data.songs.length === 0 && <p className="p-4 text-sm text-[var(--muted)]">登録された曲はありません。</p>}
        </div>
      </section>
    </div>
  );
}

function SafeError({ message }: { message: string }) {
  return <div className="space-y-3"><h1 className="text-xl font-semibold">表示できません</h1><p className="text-sm text-[var(--muted)]">{message}</p><Link href="/classroom" className="text-sm text-violet-300 hover:underline">教室へ戻る</Link></div>;
}
