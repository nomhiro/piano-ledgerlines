import Link from "next/link";
import { getAuthenticatedServerUser } from "@/lib/server/auth";
import { getAccountContextForLayout } from "@/lib/server/account";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { ForbiddenError, NotFoundError } from "@/lib/server/http";
import { getRepository, getSong, listTakesBySong } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

async function loadSong(studentId: string, songId: string, requestedClassroomId?: string) {
  const user = await getAuthenticatedServerUser();
  const account = await getAccountContextForLayout();
  const classroomId =
    account?.classrooms.find((classroom) => classroom.id === requestedClassroomId)?.id ??
    account?.activeClassroom?.id;
  if (!classroomId) throw new NotFoundError("classroom not found");
  const access = await assertTeacherCanAccessStudent(classroomId, user.id, studentId, getRepository());
  const song = await getSong(songId, studentId);
  if (!song) throw new NotFoundError("song not found");
  const profile = await getRepository().getUser(studentId);
  return {
    classroomId: access.classroom.id,
    classroomName: access.classroom.name,
    studentDisplayName: profile?.displayName?.trim() || "生徒",
    song,
    takes: await listTakesBySong(songId, studentId),
  };
}

export default async function ClassroomStudentSongPage({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string; songId: string }>;
  searchParams: Promise<{ classroomId?: string }>;
}) {
  const { studentId, songId } = await params;
  const { classroomId } = await searchParams;
  let data;
  try {
    data = await loadSong(studentId, songId, classroomId);
  } catch (error) {
    if (error instanceof ForbiddenError) return <SafeError message="この曲を表示する権限がありません。" />;
    if (error instanceof NotFoundError) return <SafeError message="曲または教室が見つかりません。" />;
    return <SafeError message="曲の情報を読み込めませんでした。" />;
  }
  const { song, takes } = data;
  return (
    <div className="space-y-5">
      <header>
        <Link href={`/classroom/students/${encodeURIComponent(studentId)}?classroomId=${encodeURIComponent(data.classroomId)}`} className="text-xs text-violet-300 hover:underline">← 生徒の曲一覧</Link>
        <h1 className="mt-3 text-2xl font-bold">{song.title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{data.studentDisplayName}さん / {song.composer} ・ 読み取り専用</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`/api/classrooms/${encodeURIComponent(data.classroomId)}/students/${encodeURIComponent(studentId)}/songs/${encodeURIComponent(songId)}/score?format=score`}
            target="_blank"
            rel="noreferrer"
            className="button-secondary"
          >
            楽譜を開く
          </a>
          <a
            href={`/api/classrooms/${encodeURIComponent(data.classroomId)}/students/${encodeURIComponent(studentId)}/songs/${encodeURIComponent(songId)}/score?format=midi`}
            className="button-secondary"
          >
            MIDIを取得
          </a>
        </div>
      </header>
      <section className="grid gap-3 sm:grid-cols-3">
        <Metric label="状態" value={song.status} />
        <Metric label="小節数" value={song.measureCount === null ? "未解析" : `${song.measureCount}小節`} />
        <Metric label="録音" value={`${takes.length}テイク`} />
      </section>
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <h2 className="border-b border-[var(--border)] p-4 font-semibold">録音履歴</h2>
        <div className="divide-y divide-[var(--border)]">
          {takes.map((take) => (
            <div key={take.id} className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span>{take.label}</span>
                <span className="text-xs text-[var(--muted)]">
                  {take.status} ・ {take.overallScore === null ? "スコア未算出" : `${take.overallScore}点`}
                </span>
              </div>
              <audio
                controls
                preload="none"
                className="max-w-full"
                src={`/api/classrooms/${encodeURIComponent(data.classroomId)}/students/${encodeURIComponent(studentId)}/takes/${encodeURIComponent(take.id)}/audio`}
                aria-label={`${take.label}の録音`}
              />
            </div>
          ))}
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
