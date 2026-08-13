"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Song } from "@/lib/mock/types";

export default function SongSelector({
  songs,
  current,
}: {
  songs: Song[];
  current: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const selectedId = songs.some((song) => song.id === current) ? current : songs[0]?.id ?? "";

  return (
    <select
      value={selectedId}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        next.set("song", e.target.value);
        router.push(`${pathname}?${next.toString()}`);
      }}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
    >
      {songs.map((s) => (
        <option key={s.id} value={s.id}>
          {s.composer}：{s.title}
        </option>
      ))}
    </select>
  );
}
