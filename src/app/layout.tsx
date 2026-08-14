import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { getAccountContext } from "@/lib/server/account";

export const metadata: Metadata = {
  title: "Ledger Lines — AIピアノ練習コーチ",
  description:
    "録音するだけで、どの小節が弱いか・前回からどう良くなったかを可視化。1曲を仕上げるためのAI練習コーチ。",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const account = await getAccountContext();
  return (
    <html lang="ja">
      <body>
        <AppShell account={account}>{children}</AppShell>
      </body>
    </html>
  );
}
