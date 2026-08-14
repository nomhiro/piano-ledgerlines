"use client";

import Link from "next/link";
import { useState } from "react";
import type { AccountContext, AccountClassroomSummary } from "@/lib/server/account";

type Member = {
  id: string;
  userId: string;
  role: "owner" | "teacher" | "student";
  status: string;
  displayName: string | null;
  email?: string | null;
};
type Invitation = {
  id: string;
  email: string;
  role: "teacher" | "student";
  status: string;
  expiresAt: string | null;
};
type ClassroomData = {
  classroom: AccountClassroomSummary & { hasBillingCustomer: boolean };
  role: "owner" | "teacher" | "student";
  members: Member[];
  invitations?: Invitation[];
};

const STATUS_LABEL: Record<string, string> = {
  none: "未契約",
  incomplete: "決済準備中",
  active: "利用中",
  past_due: "支払い確認中",
  canceled: "契約停止",
};

function safeStripeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "checkout.stripe.com" || url.hostname === "billing.stripe.com")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "処理に失敗しました。");
  return body;
}

export default function ClassroomView({
  account,
  initialClassroom,
}: {
  account: AccountContext | null;
  initialClassroom: AccountClassroomSummary | null;
}) {
  const [classroom, setClassroom] = useState<ClassroomData | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"teacher" | "student">("student");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadClassroom(id: string) {
    const data = await apiJson<ClassroomData>(`/api/classrooms/${encodeURIComponent(id)}`);
    setClassroom(data);
    setMembers(data.members);
    if (data.role === "owner" || data.role === "teacher") {
      try {
        const invitationData = await apiJson<{ invitations: Invitation[] }>(
          `/api/classrooms/${encodeURIComponent(id)}/invitations`,
        );
        setInvitations(invitationData.invitations);
      } catch {
        setInvitations([]);
      }
    }
  }

  async function runBilling(action: "checkout" | "billing-portal") {
    if (!classroom) return;
    setBusy(action);
    setError("");
    try {
      const result = await apiJson<{ url: string }>(
        `/api/classrooms/${encodeURIComponent(classroom.classroom.id)}/${action}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
        },
      );
      const url = safeStripeUrl(result.url);
      if (!url) throw new Error("安全な決済画面を確認できませんでした。");
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "決済画面を開けませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function createClassroom() {
    setBusy("create");
    setError("");
    try {
      const result = await apiJson<{ classroom: AccountClassroomSummary & { id: string } }>(
        "/api/classrooms",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      await loadClassroom(result.classroom.id);
      setName("");
      const checkout = await apiJson<{ url: string }>(
        `/api/classrooms/${encodeURIComponent(result.classroom.id)}/checkout`,
        { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } },
      );
      const url = safeStripeUrl(checkout.url);
      if (!url) throw new Error("安全な決済画面を確認できませんでした。");
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "教室を作成できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function invite() {
    if (!classroom || !email.trim()) return;
    setBusy("invite");
    setError("");
    try {
      await apiJson(`/api/classrooms/${classroom.classroom.id}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      setEmail("");
      setMessage("招待を送信しました。");
      await loadClassroom(classroom.classroom.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "招待を送信できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(userId: string) {
    if (!classroom) return;
    setBusy(`remove:${userId}`);
    setError("");
    try {
      await apiJson(`/api/classrooms/${classroom.classroom.id}/members/${userId}`, { method: "DELETE" });
      setMembers((current) => current.filter((member) => member.userId !== userId));
      setMessage("メンバーを削除しました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "メンバーを削除できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function updateInvitation(invitationId: string, action: "revoke" | "resend") {
      if (!classroom) return;
      setBusy(`${action}:${invitationId}`);
      setError("");
      try {
        await apiJson(
          `/api/classrooms/${classroom.classroom.id}/invitations/${invitationId}${action === "resend" ? "/resend" : ""}`,
          { method: action === "resend" ? "POST" : "DELETE" },
        );
        await loadClassroom(classroom.classroom.id);
        setMessage(action === "resend" ? "招待を再送しました。" : "招待を取り消しました。");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "招待を更新できませんでした。");
      } finally {
        setBusy(null);
    }
  }

  async function leave() {
    if (!classroom || !account) return;
    setBusy("leave");
    setError("");
    try {
      await apiJson(`/api/classrooms/${classroom.classroom.id}/members/${account.user.id}`, { method: "DELETE" });
      setClassroom(null);
      setMembers([]);
      setConfirmLeave(false);
      setMessage("教室から退出しました。練習データは個人利用として保持されます。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "退出できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  if (!account) {
    return <p className="text-sm text-[var(--muted)]">教室機能を利用するにはログインしてください。</p>;
  }

  if (!classroom && !initialClassroom) {
    return (
      <div className="max-w-xl space-y-5">
        <header>
          <h1 className="text-2xl font-bold">教室</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">現在は個人利用です。教室を作成すると先生と生徒を管理できます。</p>
        </header>
        <form
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
          onSubmit={(event) => { event.preventDefault(); void createClassroom(); }}
        >
          <label className="block text-sm font-medium" htmlFor="classroom-name">教室名</label>
          <input
            id="classroom-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            className="input mt-2"
            placeholder="〇〇ピアノ教室"
          />
          <button disabled={busy !== null || !name.trim()} className="mt-4 rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            {busy === "create" ? "作成中…" : "教室を作成"}
          </button>
        </form>
        <StatusMessage error={error} message={message} />
      </div>
    );
  }

  if (!classroom && initialClassroom) {
    void loadClassroom(initialClassroom.id);
    return <p className="text-sm text-[var(--muted)]" aria-live="polite">教室情報を読み込んでいます…</p>;
  }
  if (!classroom) return null;

  const status = classroom.classroom.contractStatus;
  const inactive = classroom.classroom.appStatus !== "active" || (status !== "active" && status !== "past_due");
  const isStudent = classroom.role === "student";
  const teachers = members.filter((member) => member.role === "owner" || member.role === "teacher");
  const visibleMembers = classroom.role === "teacher"
    ? members.filter((member) => member.role === "student")
    : members;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--muted)]">教室 / {classroom.role === "owner" ? "オーナー" : classroom.role === "teacher" ? "先生" : "生徒"}</p>
          <h1 className="text-2xl font-bold">{classroom.classroom.name}</h1>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${status === "past_due" ? "bg-amber-500/15 text-amber-200" : "bg-violet-500/15 text-violet-200"}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>
      {status === "past_due" && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" role="status">
          支払いの確認中です。猶予期間中は教室を利用できます。オーナーは支払い方法を確認してください。
        </div>
      )}
      {inactive && status !== "past_due" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-100" role="alert">
          この教室は現在利用できません。オーナーは決済を再開すると復旧できます。
        </div>
      )}
      <StatusMessage error={error} message={message} />

      {classroom.role === "owner" && (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <Metric label="請求対象の生徒" value={`${classroom.classroom.billableStudentCount}人`} />
            <Metric label="先生枠" value={`${classroom.classroom.teacherLimit}人`} />
            <Metric label="アプリ状態" value={classroom.classroom.appStatus} />
          </section>
          <section className="flex flex-wrap gap-2">
            {status === "none" || status === "canceled" ? (
              <button disabled={busy !== null} onClick={() => void runBilling("checkout")} className="button-primary">
                {busy === "checkout" ? "準備中…" : "決済を開始"}
              </button>
            ) : classroom.classroom.hasBillingCustomer ? (
              <button disabled={busy !== null} onClick={() => void runBilling("billing-portal")} className="button-secondary">
                {busy === "billing-portal" ? "準備中…" : "請求情報を管理"}
              </button>
            ) : null}
            <button disabled={busy !== null || inactive} onClick={async () => {
              setBusy("reconcile");
              try { await apiJson(`/api/classrooms/${classroom.classroom.id}/reconciliation`, { method: "POST" }); setMessage("請求数を再計算しました。"); } catch (caught) { setError(caught instanceof Error ? caught.message : "再計算できませんでした。"); } finally { setBusy(null); }
            }} className="button-secondary">請求数を再計算</button>
          </section>
        </>
      )}

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] p-4">
          <h2 className="font-semibold">{isStudent ? "先生" : "メンバー"}</h2>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {(isStudent ? teachers : visibleMembers).map((member) => (
            <div key={member.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{member.displayName || "名前未設定"}</div>
                <div className="text-xs text-[var(--muted)]">{member.role === "owner" ? "オーナー" : member.role === "teacher" ? "先生" : "生徒"} ・ {member.status}</div>
                {member.email && <div className="text-xs text-[var(--muted)]">{member.email}</div>}
              </div>
              {!isStudent && member.role === "student" && (
                <Link href={`/classroom/students/${encodeURIComponent(member.userId)}`} className="button-secondary">詳細を見る</Link>
              )}
              {classroom.role === "owner" && member.role !== "owner" && (
                <button disabled={busy !== null} onClick={() => void removeMember(member.userId)} className="text-xs text-red-300 hover:underline">削除</button>
              )}
            </div>
          ))}
          {(isStudent ? teachers : visibleMembers).length === 0 && <p className="p-4 text-sm text-[var(--muted)]">メンバーはいません。</p>}
        </div>
      </section>

      {!isStudent && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold">招待</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="invite-email">招待先メールアドレス</label>
            <input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="招待先メールアドレス" className="input min-w-[220px] flex-1" />
            {classroom.role === "owner" && (
              <select aria-label="招待する役割" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "teacher" | "student")} className="input w-auto">
                <option value="student">生徒</option><option value="teacher">先生</option>
              </select>
            )}
            <button disabled={busy !== null || !email.trim() || inactive} onClick={() => void invite()} className="button-primary">{busy === "invite" ? "送信中…" : "招待を送る"}</button>
          </div>
          <div className="mt-3 space-y-2 text-xs text-[var(--muted)]">
            {invitations.map((invitation) => (
              <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{invitation.email}（{invitation.role === "teacher" ? "先生" : "生徒"}） ・ {invitation.status}</span>
                <span className="flex gap-2">
                  {invitation.status === "pending" && <button disabled={busy !== null} onClick={() => void updateInvitation(invitation.id, "resend")} className="text-violet-300 hover:underline">再送</button>}
                  {classroom.role === "owner" && invitation.status !== "revoked" && <button disabled={busy !== null} onClick={() => void updateInvitation(invitation.id, "revoke")} className="text-red-300 hover:underline">取消</button>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {isStudent && (
        <section className="rounded-xl border border-red-500/25 bg-[var(--surface)] p-4">
          <h2 className="font-semibold">教室から退出</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">退出後も自分の練習データと曲は個人利用として保持されます。</p>
          {!confirmLeave ? (
            <button onClick={() => setConfirmLeave(true)} className="mt-3 text-sm text-red-300 hover:underline">退出する</button>
          ) : (
            <div className="mt-3 rounded-lg border border-red-500/30 p-3" role="alert">
              <p className="text-sm">本当に退出しますか？教室のメンバー一覧から外れます。</p>
              <div className="mt-3 flex gap-2"><button disabled={busy !== null} onClick={() => void leave()} className="button-danger">退出を確定</button><button onClick={() => setConfirmLeave(false)} className="button-secondary">キャンセル</button></div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"><div className="text-xs text-[var(--muted)]">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>;
}
function StatusMessage({ error, message }: { error: string; message: string }) {
  return <div aria-live="polite">{error && <p className="text-sm text-red-300" role="alert">{error}</p>}{message && <p className="text-sm text-green-300">{message}</p>}</div>;
}
