"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Music4,
  Mic,
  Sparkles,
  TrendingUp,
  Users,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AccountContext } from "@/lib/server/account";
import { getAvatarLabel, safeAccountDisplayName } from "@/lib/account-view-model";

const NAV = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard, exact: true },
  { href: "/songs", label: "曲ライブラリ", icon: Music4 },
  { href: "/record", label: "録音する", icon: Mic },
  { href: "/coach", label: "AIコーチ", icon: Sparkles },
  { href: "/progress", label: "履歴・比較", icon: TrendingUp },
  { href: "/share", label: "先生と共有", icon: Users },
];

const CLASSROOM_NAV = { href: "/classroom", label: "教室", icon: Users, exact: false };

export default function AppShell({
  children,
  account,
}: {
  children: ReactNode;
  account: AccountContext | null;
}) {
  const pathname = usePathname();
  const displayName = account
    ? safeAccountDisplayName(account.profile.displayName, account.profile.email)
    : "";
  const initials = account ? getAvatarLabel(displayName, account.profile.email) : "LL";
  const classroomName =
    account?.mode === "classroom" ? account.activeClassroom?.name : undefined;
  const classroomRole =
    account?.mode === "classroom" ? account.activeClassroom?.role : undefined;
  const accountContextLabel = classroomName
    ? `${classroomName} ・ ${
        classroomRole === "owner"
          ? "オーナー"
          : classroomRole === "teacher"
            ? "先生"
            : "生徒"
      }`
    : "個人利用";
  const nav = account?.mode === "classroom" ? [...NAV, CLASSROOM_NAV] : NAV;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500">
            <Music4 size={18} className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold">Ledger Lines</div>
            <div className="text-[10px] text-[var(--muted)]">AI Piano Practice Coach</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {nav.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                  active
                    ? "bg-violet-500/15 text-violet-300"
                    : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
                }`}
              >
                <Icon size={16} aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3">
          <Link
            href="/songs/new"
            className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
          >
            <Plus size={15} aria-hidden="true" />
            曲を追加
          </Link>
          <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-semibold">
              {initials}
            </div>
            <div className="leading-tight">
              {account ? (
                <>
                  <div className="max-w-[160px] truncate text-xs">{displayName}</div>
                  <div className="max-w-[160px] truncate text-[10px] text-[var(--muted)]">{account.profile.email}</div>
                </>
              ) : (
                <div className="text-xs text-[var(--muted)]">ログインが必要です</div>
              )}
              <div className="text-[10px] text-[var(--muted)]">
                {accountContextLabel}
              </div>
              {account && (
                <a
                  href="/.auth/logout?post_logout_redirect_uri=%2F"
                  className="mt-1 inline-block text-[10px] text-violet-300 hover:underline"
                >
                  ログアウト
                </a>
              )}
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:hidden">
          <Music4 size={18} className="text-violet-400" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-bold">Ledger Lines</span>
          {account && (
            <div className="min-w-0 text-right leading-tight">
              <div className="max-w-[160px] truncate text-xs">{displayName}</div>
              <div className="max-w-[160px] truncate text-[10px] text-[var(--muted)]">{account.profile.email}</div>
              <div className="max-w-[160px] truncate text-[10px] text-[var(--muted)]">
                {accountContextLabel}
              </div>
              <a
                href="/.auth/logout?post_logout_redirect_uri=%2F"
                className="text-[10px] text-violet-300 hover:underline"
              >
                ログアウト
              </a>
            </div>
          )}
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2 py-2 md:hidden">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-[var(--muted)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {account?.mode !== "classroom" && (
          <Link
            href="/classroom"
            className="mx-3 mb-3 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-center text-xs text-violet-200"
          >
            教室を作成・参加する
          </Link>
        )}
        <main className="mx-auto max-w-[1180px] px-5 py-7">{children}</main>
      </div>
    </div>
  );
}
