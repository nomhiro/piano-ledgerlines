"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Link2,
  Copy,
  Check,
  MessageSquare,
  Send,
  ClipboardList,
  Eye,
  Users,
} from "lucide-react";
import type { Song, Take, TeacherComment, Assignment } from "@/lib/mock/types";
import { Badge, Card, CardTitle, ScoreRing } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
import { daysUntil, formatDate, formatDateTime } from "@/lib/format";

const STATUS_META = {
  todo: { label: "未着手", color: "#8d97ad" },
  doing: { label: "取り組み中", color: "#38bdf8" },
  done: { label: "完了", color: "#22c55e" },
} as const;

export default function ShareView({
  songs,
  song,
  takes,
  comments: initialComments,
  assignments: initialAssignments,
  viewerDisplayName,
  teacherDisplayName,
  classroomName,
}: {
  songs: Song[];
  song: Song;
  takes: Take[];
  comments: TeacherComment[];
  assignments: Assignment[];
  viewerDisplayName?: string;
  teacherDisplayName?: string | null;
  classroomName?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [comments, setComments] = useState(initialComments);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState<number | "">("");
  const latest = takes[takes.length - 1];
  const shareUrl = `https://ledgerlines.app/s/${song.id}-7f3a9c`;
  const nextId = useRef(0);
  const viewerName = viewerDisplayName?.trim() || "あなた";

  function post() {
    if (!body.trim()) return;
    nextId.current += 1;
    setComments((c) => [
      ...c,
      {
        id: `new-${nextId.current}`,
        songId: song.id,
        takeId: latest.id,
        measure: pinned === "" ? null : Number(pinned),
        author: viewerName,
        role: "student",
        body,
        createdAt: "2026-07-25T13:40:00+09:00",
      },
    ]);
    setBody("");
    setPinned("");
  }

  function cycleStatus(id: string) {
    setAssignments((list) =>
      list.map((a) =>
        a.id === id
          ? {
              ...a,
              status: a.status === "todo" ? "doing" : a.status === "doing" ? "done" : "todo",
            }
          : a,
      ),
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">先生と共有</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            録音と分析レポートをそのまま共有。レッスンの間の1週間が可視化されます。
          </p>
        </div>
        <SongSelector songs={songs} current={song.id} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* 共有リンク */}
          <Card>
            <CardTitle
              title="共有リンク"
              subtitle="リンクを知っている人だけが閲覧できます（読み取り専用）"
              right={<Badge color="#06b6d4">共有中</Badge>}
            />
            <div className="p-5">
              <div className="flex flex-wrap gap-2">
                <div className="flex min-w-[240px] flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5">
                  <Link2 size={15} className="shrink-0 text-[var(--muted)]" />
                  <span className="truncate text-xs">{shareUrl}</span>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(shareUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "コピーしました" : "コピー"}
                </button>
              </div>

              <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                {[
                  "録音音声（全テイク）",
                  "分析レポート（6指標・小節ヒートマップ）",
                  "AI講評と練習メニュー",
                  "練習ログ・スコア推移",
                ].map((s) => (
                  <label
                    key={s}
                    className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Eye size={13} className="text-[var(--muted)]" />
                      {s}
                    </span>
                    <input type="checkbox" defaultChecked className="h-4 w-4 accent-violet-500" />
                  </label>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-300">
                  <Users size={16} />
                </div>
                <div className="flex-1">
                  <div className="text-sm">{teacherDisplayName?.trim() || "共有先の先生"}</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    {classroomName?.trim() || "教室未設定"} ・ 共有設定を確認してください
                  </div>
                </div>
                <Badge color="#22c55e">閲覧済み</Badge>
              </div>
            </div>
          </Card>

          {/* コメントスレッド */}
          <Card>
            <CardTitle
              title="レッスンノート"
              subtitle="小節にピン留めしてやりとりできます"
              right={
                <span className="text-xs text-[var(--muted)]">{comments.length} 件</span>
              }
            />
            <div className="divide-y divide-[var(--border)]">
              {comments.map((c) => (
                <div key={c.id} className="flex gap-3 px-5 py-4">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      c.role === "teacher"
                        ? "bg-cyan-500/20 text-cyan-300"
                        : "bg-violet-500/20 text-violet-300"
                    }`}
                  >
                    {c.role === "teacher" ? "師" : "私"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold">{c.role === "teacher" ? "先生" : viewerName}</span>
                      {c.measure !== null && (
                        <Badge color="#a78bfa">{c.measure} 小節</Badge>
                      )}
                      {c.takeId && (
                        <Link
                          href={`/takes/${c.takeId}`}
                          className="text-[10px] text-violet-300 hover:underline"
                        >
                          該当テイクを見る
                        </Link>
                      )}
                      <span className="text-[10px] text-[var(--muted)]">
                        {formatDateTime(c.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-[var(--border)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <MessageSquare size={13} className="text-[var(--muted)]" />
                <select
                  value={pinned}
                  onChange={(e) =>
                    setPinned(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[11px]"
                >
                  <option value="">小節を指定しない</option>
                  {latest.measureScores.map((m) => (
                    <option key={m.measure} value={m.measure}>
                      {m.measure} 小節
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && post()}
                  placeholder="先生にメッセージを送る"
                  className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs outline-none"
                />
                <button
                  onClick={post}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white hover:bg-violet-500"
                >
                  <Send size={15} />
                </button>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          {/* 課題 */}
          <Card>
            <CardTitle
              title="先生からの課題"
              subtitle="次回レッスンまでの宿題"
              right={
                <ClipboardList size={15} className="text-[var(--muted)]" />
              }
            />
            <div className="space-y-2.5 p-5">
              {assignments.length === 0 && (
                <p className="text-xs text-[var(--muted)]">課題はありません。</p>
              )}
              {assignments.map((a) => {
                const meta = STATUS_META[a.status];
                const left = daysUntil(a.dueDate);
                return (
                  <div
                    key={a.id}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`text-sm ${a.status === "done" ? "text-[var(--muted)] line-through" : ""}`}
                      >
                        {a.title}
                      </span>
                      <button onClick={() => cycleStatus(a.id)}>
                        <Badge color={meta.color}>{meta.label}</Badge>
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
                      {a.detail}
                    </p>
                    <div className="mt-2 text-[10px] text-[var(--muted)]">
                      期限 {a.dueDate}
                      {left >= 0 ? `（あと ${left} 日）` : "（期限超過）"}
                    </div>
                  </div>
                );
              })}
              <p className="pt-1 text-[10px] text-[var(--muted)]">
                ※ ステータスバッジをクリックすると状態が切り替わります（モック）。
              </p>
            </div>
          </Card>

          {/* 共有されるレポートのプレビュー */}
          <Card>
            <CardTitle title="先生に見える内容" subtitle="共有リンクのプレビュー" />
            <div className="p-5">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
                <div className="text-xs font-semibold">{song.title}</div>
                <div className="text-[10px] text-[var(--muted)]">
                  {song.composer} ・ {viewerName}さんの練習レポート
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <ScoreRing score={latest.overallScore} size={56} />
                  <div className="text-[10px] text-[var(--muted)]">
                    <div>最新 {formatDate(latest.recordedAt)}</div>
                    <div>テイク {takes.length} 件</div>
                    <div>指摘 {latest.issues.length} 件</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {latest.measureScores.slice(0, 16).map((m) => (
                    <span
                      key={m.measure}
                      className="h-3 w-3 rounded-sm"
                      style={{
                        backgroundColor:
                          m.score >= 85
                            ? "#22c55e"
                            : m.score >= 70
                              ? "#84cc16"
                              : m.score >= 55
                                ? "#eab308"
                                : m.score >= 40
                                  ? "#f97316"
                                  : "#ef4444",
                      }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
                先生は生徒ごとの練習ログ・スコア推移・停滞小節を一覧で確認できます。
                レッスンの冒頭で「今週どこで詰まったか」を探る時間が不要になります。
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
