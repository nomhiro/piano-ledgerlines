"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteSong, updateSong } from "@/lib/api/client";

export default function SongManagementControls({
  song,
}: {
  song: {
    id: string;
    title: string;
    composer: string;
    targetTempo: number | null;
  };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(song.title);
  const [composer, setComposer] = useState(song.composer);
  const [targetTempo, setTargetTempo] = useState(song.targetTempo?.toString() ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateSong(song.id, {
        title,
        composer,
        targetTempo: targetTempo === "" ? null : Number(targetTempo),
      });
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`「${song.title}」と関連する録音・解析データを完全に削除します。元に戻せません。`)) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await deleteSong(song.id);
      router.push("/songs");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-[var(--border)] p-4" aria-label="曲の管理">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          aria-expanded={editing}
          aria-controls="song-edit-form"
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:border-violet-500/50"
        >
          {editing ? "編集を閉じる" : "曲情報を編集"}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={saving}
          className="rounded-lg border border-red-500/50 px-3 py-2 text-sm text-red-300 hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          曲を削除
        </button>
      </div>
      {editing && (
        <form id="song-edit-form" onSubmit={(event) => void save(event)} className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">曲名</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">作曲者</span>
            <input
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              maxLength={200}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">目標テンポ</span>
            <input
              type="number"
              value={targetTempo}
              onChange={(event) => setTargetTempo(event.target.value)}
              min={20}
              max={300}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    </section>
  );
}
