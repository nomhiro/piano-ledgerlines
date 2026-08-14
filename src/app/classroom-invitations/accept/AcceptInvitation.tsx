"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildLoginReturnUri, invitationStorageKey } from "./invitation-client";

type State = "loading" | "login" | "success" | "error";

function errorMessage(code: string | undefined, message: string | undefined): string {
  if (code === "FORBIDDEN" && message?.includes("email")) return "この招待は、招待先のGoogleアカウントでのみ承諾できます。";
  if (message?.includes("expired")) return "この招待の有効期限が切れています。招待者に再送を依頼してください。";
  if (message?.includes("revoked")) return "この招待は取り消されています。";
  if (message?.includes("already") || message?.includes("used")) return "この招待はすでに使用されています。";
  if (code === "UNAUTHENTICATED") return "Googleアカウントでログインしてください。";
  return "招待を承諾できませんでした。招待リンクを確認するか、招待者にお問い合わせください。";
}

export default function AcceptInvitation() {
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState("招待を確認しています…");

  useEffect(() => {
    const fragmentValues = new URLSearchParams(window.location.hash.slice(1));
    const queryValues = new URLSearchParams(window.location.search);
    const classroomId = fragmentValues.get("classroomId") ?? queryValues.get("classroomId");
    const invitationId = fragmentValues.get("invitationId") ?? queryValues.get("invitationId");
    const storageKey = classroomId && invitationId
      ? invitationStorageKey(classroomId, invitationId)
      : null;
    const secret = fragmentValues.get("secret") ??
      (storageKey ? window.sessionStorage.getItem(storageKey) : null);
    if (!classroomId || !invitationId || !secret) {
      queueMicrotask(() => {
        setState("error");
        setMessage("招待情報が見つかりません。招待メールのリンクを同じタブで開き直してください。");
      });
      return;
    }
    if (fragmentValues.get("secret")) {
      window.sessionStorage.setItem(storageKey!, secret);
    }
    window.history.replaceState(null, "", window.location.pathname);
    void fetch("/api/classroom-invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ classroomId, invitationId, secret }),
    }).then(async (response) => {
      const body = await response.json() as { error?: { code?: string; message?: string } };
      if (response.status === 401) {
        setState("login");
        setMessage("Googleアカウントでログインしています…");
        const returnUri = buildLoginReturnUri(
          window.location.origin,
          window.location.pathname,
          classroomId,
          invitationId,
        );
        window.location.assign(`/.auth/login/google?post_login_redirect_uri=${encodeURIComponent(returnUri)}`);
        return;
      }
      if (!response.ok) {
        setState("error");
        setMessage(errorMessage(body.error?.code, body.error?.message));
        return;
      }
      if (storageKey) window.sessionStorage.removeItem(storageKey);
      setState("success");
      setMessage("教室への参加が完了しました。");
    }).catch(() => {
      setState("error");
      setMessage("通信に失敗しました。しばらくしてから再度お試しください。");
    });
  }, []);

  return (
    <section className="mx-auto max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <h1 className="text-xl font-semibold">教室招待</h1>
      <p className={`mt-4 text-sm ${state === "error" ? "text-red-300" : "text-[var(--muted)]"}`}>{message}</p>
      {state === "login" && <a className="mt-6 inline-block rounded-lg bg-violet-600 px-4 py-2 text-sm text-white" href="/.auth/login/google">Googleでログイン</a>}
      {state === "success" && <Link className="mt-6 inline-block rounded-lg bg-violet-600 px-4 py-2 text-sm text-white" href="/">ダッシュボードへ</Link>}
    </section>
  );
}
