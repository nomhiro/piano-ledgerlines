"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountContext, AccountClassroomSummary } from "@/lib/server/account";

type Member = {
  id?: string;
  userId?: string;
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
  deliveryStatus?: "pending" | "sent" | "failed";
};
type ClassroomData = {
  classroom: Pick<
    AccountClassroomSummary,
    "id" | "name" | "appStatus" | "contractStatus" | "teacherLimit" | "billableStudentCount"
  > & { hasBillingCustomer: boolean };
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
const APP_STATUS_LABEL: Record<string, string> = {
  provisioning: "準備中",
  active: "利用中",
  suspended: "停止中",
  archived: "終了",
};
const INVITATION_STATUS_LABEL: Record<string, string> = {
  preparing: "準備中",
  pending: "承諾待ち",
  accepting: "承諾処理中",
  accepted: "承諾済み",
  expired: "期限切れ",
  revoked: "取消済み",
};
const MEMBER_STATUS_LABEL: Record<string, string> = {
  provisioning: "準備中",
  active: "在籍中",
  removing: "除籍処理中",
  removed: "除籍済み",
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
  if (!response.ok) {
    const code = (body.error as { code?: string } | undefined)?.code;
    const userMessage: Record<string, string> = {
      FORBIDDEN: "この操作を行う権限がありません。",
      NOT_FOUND: "教室または対象が見つかりません。",
      CONFLICT: "状態が変わりました。最新の情報を読み込んで再試行してください。",
      QUOTA_EXCEEDED: "利用上限に達しています。",
      CONFIGURATION_ERROR: "請求設定が未完了です。管理者に確認してください。",
      BILLING_IN_PROGRESS: "請求処理中です。少し待ってから再試行してください。",
      VALIDATION_FAILED: "入力内容を確認してください。",
    };
    throw new Error(userMessage[code ?? ""] ?? body.error?.message ?? "処理に失敗しました。");
  }
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
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [invitationError, setInvitationError] = useState("");
  const loadedClassroomId = useRef<string | null>(null);
  const loadVersion = useRef(0);
  const confirmationRef = useRef<HTMLButtonElement>(null);
  const activeConfirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousConfirmation = useRef<string | null>(null);
  const [leftClassroom, setLeftClassroom] = useState(false);
  const router = useRouter();

  const loadClassroom = useCallback(async (id: string, version = loadVersion.current) => {
    const data = await apiJson<ClassroomData>(`/api/classrooms/${encodeURIComponent(id)}`);
    if (version !== loadVersion.current) return;
    setClassroom(data);
    setMembers(data.members);
    setInvitationError("");
    if (data.role === "owner" || data.role === "teacher") {
      try {
        const invitationData = await apiJson<{ invitations: Invitation[] }>(
          `/api/classrooms/${encodeURIComponent(id)}/invitations`,
        );
        if (version !== loadVersion.current) return;
        setInvitations(invitationData.invitations);
      } catch (caught) {
        if (version !== loadVersion.current) return;
        setInvitations([]);
        setInvitationError(
          caught instanceof Error ? caught.message : "招待状況を読み込めませんでした。",
        );
      }
    } else {
      setInvitations([]);
    }
  }, []);

  useEffect(() => {
    const id = initialClassroom?.id;
    if (!id || loadedClassroomId.current === id) return;
    loadedClassroomId.current = id;
    const version = ++loadVersion.current;
    setClassroom(null);
    setMembers([]);
    setInvitations([]);
    setPendingRemoval(null);
    setPendingRevoke(null);
    setConfirmLeave(false);
    setBusy(null);
    setName("");
    setEmail("");
    setInviteRole("student");
    setNameError("");
    setEmailError("");
    setMessage("");
    setError("");
    setInvitationError("");
    setLeftClassroom(false);
    let cancelled = false;
    void loadClassroom(id, version).catch((caught) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : "教室情報を読み込めませんでした。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialClassroom?.id, loadClassroom]);

  const confirmationKey = pendingRemoval
    ? `remove:${pendingRemoval}`
    : pendingRevoke
      ? `revoke:${pendingRevoke}`
      : confirmLeave
        ? "leave"
        : null;

  useEffect(() => {
    if (confirmationKey) {
      confirmationRef.current?.focus();
    } else if (previousConfirmation.current) {
      if (activeConfirmationTriggerRef.current?.isConnected) {
        activeConfirmationTriggerRef.current.focus();
      } else {
        document.getElementById("classroom-heading")?.focus();
      }
      activeConfirmationTriggerRef.current = null;
    }
    previousConfirmation.current = confirmationKey;
  }, [confirmationKey]);

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
    if (!name.trim()) {
      setNameError("教室名を入力してください。");
      return;
    }
    setNameError("");
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
      loadedClassroomId.current = result.classroom.id;
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
    if (!classroom) return;
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError("有効なメールアドレスを入力してください。");
      return;
    }
    setEmailError("");
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
      setPendingRemoval(null);
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
      setLeftClassroom(true);
      setConfirmLeave(false);
      setMessage("教室から退出しました。練習データは個人利用として保持されます。");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "退出できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function updateName() {
    if (!classroom || !name.trim()) {
      setNameError("教室名を入力してください。");
      return;
    }
    setNameError("");
    setBusy("rename");
    setError("");
    try {
      const result = await apiJson<{ classroom: ClassroomData["classroom"] }>(
        `/api/classrooms/${encodeURIComponent(classroom.classroom.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      setClassroom((current) =>
        current ? { ...current, classroom: { ...current.classroom, ...result.classroom } } : current,
      );
      setName("");
      setMessage("教室名を更新しました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "教室名を更新できませんでした。");
    } finally {
      setBusy(null);
    }
  }

  if (!account) {
    return <p className="text-sm text-[var(--muted)]">教室機能を利用するにはログインしてください。</p>;
  }

  if (leftClassroom) {
    return (
      <section className="space-y-4" role="status" aria-live="polite">
        <h1 className="text-2xl font-bold">教室から退会しました</h1>
        <p className="text-sm text-[var(--muted)]">
          曲・録音・テイクは個人利用のデータとして残っています。
        </p>
        <Link href="/" className="button-primary inline-block">
          個人ダッシュボードへ戻る
        </Link>
      </section>
    );
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
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError("");
            }}
            required
            maxLength={120}
            className="input mt-2"
            placeholder="〇〇ピアノ教室"
            aria-describedby={`classroom-create-help${nameError ? " classroom-create-error" : ""}`}
            aria-invalid={nameError ? "true" : undefined}
          />
          <p id="classroom-create-help" className="mt-1 text-xs text-[var(--muted)]">1文字以上120文字以内で入力してください。</p>
          {nameError && <p id="classroom-create-error" className="text-sm text-red-300" role="alert">{nameError}</p>}
          <button disabled={busy !== null || !name.trim()} className="mt-4 rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            {busy === "create" ? "作成中…" : "教室を作成"}
          </button>
        </form>
        <StatusMessage error={error} message={message} />
      </div>
    );
  }

  if (!classroom && initialClassroom && !leftClassroom) {
    if (error) {
      return (
        <div className="space-y-3" role="alert">
          <h1 className="text-xl font-semibold">教室を表示できません</h1>
          <p className="text-sm text-red-300">{error}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              const id = initialClassroom.id;
              setError("");
              loadedClassroomId.current = id;
              const version = ++loadVersion.current;
              setClassroom(null);
              setBusy("load");
              void loadClassroom(id, version)
                .catch((caught) => {
                  setError(caught instanceof Error ? caught.message : "教室情報を読み込めませんでした。");
                })
                .finally(() => setBusy(null));
            }}
          >
            {busy === "load" ? "読み込み中…" : "再試行"}
          </button>
        </div>
      );
    }
    return <p className="text-sm text-[var(--muted)]" aria-live="polite" aria-busy="true">教室情報を読み込んでいます…</p>;
  }
  if (!classroom) return null;

  const status = classroom.classroom.contractStatus;
  const inactive = classroom.classroom.appStatus !== "active" || (status !== "active" && status !== "past_due");
  const canViewStudentData = !inactive;
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
          <h1 id="classroom-heading" tabIndex={-1} className="text-2xl font-bold">{classroom.classroom.name}</h1>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${status === "past_due" ? "bg-amber-500/15 text-amber-200" : "bg-violet-500/15 text-violet-200"}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>
      {account.classrooms.length > 1 && (
        <nav aria-label="教室を選択">
          <ul className="flex flex-wrap gap-2">
            {account.classrooms.map((summary) => (
              <li key={summary.id}>
                <Link
                  href={`/classroom?classroomId=${encodeURIComponent(summary.id)}`}
                  aria-current={summary.id === classroom.classroom.id ? "page" : undefined}
                  className={`inline-block rounded-lg border px-3 py-2 text-xs ${
                    summary.id === classroom.classroom.id
                      ? "border-violet-400 bg-violet-500/15 text-violet-100"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {summary.name}（{summary.role === "owner" ? "オーナー" : summary.role === "teacher" ? "先生" : "生徒"}）
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
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
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="font-semibold">教室設定</h2>
            <form
              className="mt-3 flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void updateName();
              }}
            >
              <label className="min-w-[220px] flex-1 text-sm">
                教室名
                <input
                  className="input mt-1"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError) setNameError("");
                  }}
                  maxLength={120}
                  required
                  aria-describedby={`classroom-name-help${nameError ? " classroom-name-error" : ""}`}
                  aria-invalid={nameError ? "true" : undefined}
                />
              </label>
              <span id="classroom-name-help" className="sr-only">
                1文字以上120文字以内で入力してください。
              </span>
              {nameError && <p id="classroom-name-error" className="text-sm text-red-300" role="alert">{nameError}</p>}
              <button type="submit" disabled={busy !== null || !name.trim()} className="button-secondary self-end">
                {busy === "rename" ? "更新中…" : "教室名を更新"}
              </button>
            </form>
          </section>
          <section className="grid gap-3 sm:grid-cols-3">
            <Metric label="請求対象の生徒" value={`${classroom.classroom.billableStudentCount}人`} />
            <Metric label="先生枠" value={`${classroom.classroom.teacherLimit}人`} />
            <Metric label="アプリ状態" value={APP_STATUS_LABEL[classroom.classroom.appStatus] ?? "確認中"} />
          </section>
          <section className="flex flex-wrap gap-2">
            {status !== "active" && status !== "past_due" ? (
              <button type="button" disabled={busy !== null} onClick={() => void runBilling("checkout")} className="button-primary">
                {busy === "checkout" ? "準備中…" : "決済を開始"}
              </button>
            ) : classroom.classroom.hasBillingCustomer ? (
              <button type="button" disabled={busy !== null} onClick={() => void runBilling("billing-portal")} className="button-secondary">
                {busy === "billing-portal" ? "準備中…" : "請求情報を管理"}
              </button>
            ) : null}
            <button type="button" disabled={busy !== null} onClick={async () => {
              setBusy("reconcile");
              setError("");
              try {
                const result = await apiJson<{ classroom: ClassroomData["classroom"] }>(
                  `/api/classrooms/${classroom.classroom.id}/reconciliation`,
                  { method: "POST" },
                );
                setClassroom((current) =>
                  current ? { ...current, classroom: { ...current.classroom, ...result.classroom } } : current,
                );
                setMessage("請求数を再計算しました。");
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "再計算できませんでした。");
              } finally {
                setBusy(null);
              }
            }} className="button-secondary">請求数を再計算</button>
          </section>
        </>
      )}

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] p-4">
          <h2 className="font-semibold">{isStudent ? "先生" : "メンバー"}</h2>
        </div>
        <ul className="divide-y divide-[var(--border)]">
          {(isStudent ? teachers : visibleMembers).map((member, index) => (
            <li key={member.userId ?? `${member.role}:${member.displayName ?? "member"}:${index}`} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{member.displayName || "名前未設定"}</div>
                <div className="text-xs text-[var(--muted)]">
                  {member.role === "owner" ? "オーナー" : member.role === "teacher" ? "先生" : "生徒"}
                  {member.status ? ` ・ ${MEMBER_STATUS_LABEL[member.status] ?? member.status}` : ""}
                </div>
                {member.email && <div className="text-xs text-[var(--muted)]">{member.email}</div>}
              </div>
              {!isStudent && member.role === "student" && member.userId && canViewStudentData && (
                <Link href={`/classroom/students/${encodeURIComponent(member.userId)}?classroomId=${encodeURIComponent(classroom.classroom.id)}`} className="button-secondary">詳細を見る</Link>
              )}
              {classroom.role === "owner" && member.role !== "owner" && member.userId && (
                pendingRemoval === member.userId ? (
                  <span className="flex items-center gap-2 text-xs" role="alert" aria-live="assertive" onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setPendingRemoval(null);
                    }
                  }}>
                    <span>除籍しますか？</span>
                    <button
                      type="button"
                      ref={confirmationRef}
                      aria-describedby={`remove-description-${member.userId}`}
                      disabled={busy !== null}
                      onClick={() => {
                        if (member.userId) void removeMember(member.userId);
                      }}
                      className="text-red-300 hover:underline"
                    >
                      <span id={`remove-description-${member.userId}`} className="sr-only">このメンバーを教室から除籍します。</span>
                      確定
                    </button>
                    <button type="button" onClick={() => setPendingRemoval(null)} className="hover:underline">
                      キャンセル
                    </button>
                  </span>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={(event) => {
                  if (member.userId) {
                    activeConfirmationTriggerRef.current = event.currentTarget;
                    setPendingRevoke(null);
                    setConfirmLeave(false);
                    setPendingRemoval(member.userId);
                  }
                  }} className="text-xs text-red-300 hover:underline">除籍</button>
                )
              )}
            </li>
          ))}
          {(isStudent ? teachers : visibleMembers).length === 0 && <li className="p-4 text-sm text-[var(--muted)]">メンバーはいません。</li>}
        </ul>
      </section>

      {!isStudent && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold">招待</h2>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[220px] flex-1 text-sm" htmlFor="invite-email">
              招待先メールアドレス
              <input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) setEmailError("");
                }}
                className="input mt-1"
                required
                aria-describedby={`invite-email-help${emailError ? " invite-email-error" : ""}`}
                aria-invalid={emailError ? "true" : undefined}
              />
            </label>
            <span id="invite-email-help" className="sr-only">招待を送る相手のメールアドレスを入力してください。</span>
            {emailError && <span id="invite-email-error" className="text-sm text-red-300" role="alert">{emailError}</span>}
            {classroom.role === "owner" && (
              <label className="text-sm">
                役割
                <select aria-label="招待する役割" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "teacher" | "student")} className="input mt-1 w-auto">
                <option value="student">生徒</option><option value="teacher">先生</option>
                </select>
              </label>
            )}
            <button type="button" disabled={busy !== null || !email.trim() || !canViewStudentData} aria-describedby={!canViewStudentData ? "invite-disabled-help" : undefined} onClick={() => void invite()} className="button-primary">{busy === "invite" ? "送信中…" : "招待を送る"}</button>
          </div>
          {!canViewStudentData && <p id="invite-disabled-help" className="mt-2 text-sm text-amber-200" role="status">契約が停止中のため、招待と生徒閲覧は請求復旧後に利用できます。</p>}
          {invitationError && <p className="mt-2 text-sm text-amber-200" role="status">{invitationError}</p>}
          <ul className="mt-3 space-y-2 text-xs text-[var(--muted)]">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {invitation.email}（{invitation.role === "teacher" ? "先生" : "生徒"}） ・{" "}
                  {INVITATION_STATUS_LABEL[invitation.status] ?? invitation.status}
                  {invitation.deliveryStatus === "failed" ? " ・ 配信失敗" : ""}
                </span>
                <span className="flex gap-2">
                  {(invitation.status === "pending" || invitation.deliveryStatus === "failed") && <button type="button" disabled={busy !== null} onClick={() => void updateInvitation(invitation.id, "resend")} className="text-violet-300 hover:underline">再送</button>}
                  {classroom.role === "owner" && invitation.status !== "revoked" && (
                    pendingRevoke === invitation.id ? (
                      <span className="flex items-center gap-2" role="alert" aria-live="assertive" onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setPendingRevoke(null);
                        }
                      }}>
                        <button
                          type="button"
                          ref={confirmationRef}
                          aria-describedby={`revoke-description-${invitation.id}`}
                          disabled={busy !== null}
                          onClick={() => {
                            setPendingRevoke(null);
                            void updateInvitation(invitation.id, "revoke");
                          }}
                          className="text-red-300 hover:underline"
                        >
                          <span id={`revoke-description-${invitation.id}`} className="sr-only">この招待を取り消します。</span>
                          確定
                        </button>
                        <button type="button" onClick={() => setPendingRevoke(null)} className="hover:underline">戻る</button>
                      </span>
                    ) : (
                      <button type="button" disabled={busy !== null} onClick={(event) => {
                        activeConfirmationTriggerRef.current = event.currentTarget;
                        setPendingRemoval(null);
                        setConfirmLeave(false);
                        setPendingRevoke(invitation.id);
                      }} className="text-red-300 hover:underline">取消</button>
                    )
                  )}
                </span>
              </li>
            ))}
            {invitations.length === 0 && <li className="text-[var(--muted)]">保留中の招待はありません。</li>}
          </ul>
        </section>
      )}

      {isStudent && (
        <section className="rounded-xl border border-red-500/25 bg-[var(--surface)] p-4">
          <h2 className="font-semibold">教室から退出</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">退出後も自分の練習データと曲は個人利用として保持されます。</p>
          {!confirmLeave ? (
            <button
              type="button"
              onClick={(event) => {
                activeConfirmationTriggerRef.current = event.currentTarget;
                setPendingRemoval(null);
                setPendingRevoke(null);
                setConfirmLeave(true);
              }}
              className="mt-3 text-sm text-red-300 hover:underline"
            >
              退出する
            </button>
          ) : (
          <div
            className="mt-3 rounded-lg border border-red-500/30 p-3"
            role="alert"
            aria-describedby="leave-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setConfirmLeave(false);
              }
            }}
          >
            <p id="leave-description" className="text-sm">本当に退出しますか？教室のメンバー一覧から外れます。練習データと曲は個人利用として保持されます。</p>
            <div className="mt-3 flex gap-2">
              <button type="button" ref={confirmationRef} disabled={busy !== null} onClick={() => void leave()} className="button-danger">退出を確定</button>
              <button type="button" onClick={() => setConfirmLeave(false)} className="button-secondary">キャンセル</button>
            </div>
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
  return <div aria-live="polite" aria-atomic="true">{error && <p className="text-sm text-red-300" role="alert">{error}</p>}{message && <p className="text-sm text-green-300" role="status">{message}</p>}</div>;
}
