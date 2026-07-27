import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Ledger Lines — AIピアノ練習コーチ",
  description:
    "録音するだけで、どの小節が弱いか・前回からどう良くなったかを可視化。1曲を仕上げるためのAI練習コーチ。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
