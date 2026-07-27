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

const NAV = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard, exact: true },
  { href: "/songs", label: "曲ライブラリ", icon: Music4 },
  { href: "/record", label: "録音する", icon: Mic },
  { href: "/coach", label: "AIコーチ", icon: Sparkles },
  { href: "/progress", label: "履歴・比較", icon: TrendingUp },
  { href: "/share", label: "先生と共有", icon: Users },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

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
          {NAV.map((item) => {
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
                <Icon size={16} />
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
            <Plus size={15} />
            曲を追加
          </Link>
          <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-semibold">
              野村
            </div>
            <div className="leading-tight">
              <div className="text-xs">野村 大樹</div>
              <div className="text-[10px] text-[var(--muted)]">白鳥ピアノ教室</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:hidden">
          <Music4 size={18} className="text-violet-400" />
          <span className="text-sm font-bold">Ledger Lines</span>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2 py-2 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-[var(--muted)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto max-w-[1180px] px-5 py-7">{children}</main>
      </div>
    </div>
  );
}
