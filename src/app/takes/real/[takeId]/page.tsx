"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import {
  getSong,
  getTake,
  submitTake,
  type ApiSong,
  type ApiTakeDetail,
  type ApiTakeSummary,
} from "@/lib/api/client";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import TakeScoreCard from "@/components/TakeScoreCard";
import { takeNeighbors } from "@/components/take-navigation";
import { formatDateTime } from "@/lib/format";

export default function RealTakeResultPage() {
  const params = useParams<{ takeId: string }>();
  const takeId = params.takeId;
  const [take, setTake] = useState<ApiTakeDetail | null>(null);
  const [error, setError] = useState("");
  // 曲名と、同じ曲のテイク一覧（前後移動用）。取得できなくても分析結果は
  // 描き続ける——この画面の主目的は分析結果で、導線はその上乗せなので、
  // ここで error にすると本体まで消えてしまう。
  const [songContext, setSongContext] = useState<{
    song: ApiSong;
    takes: ApiTakeSummary[];
  } | null>(null);
  // 再解析リクエストの送信中フラグ。true の間はボタンを無効化し、
  // ダブルクリックで submit が2回飛ぶのを防ぐ（このコンポーネント内だけの
  // 一時状態なので、TakeEvaluationPanel 側には持たせない）。
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getTake(takeId);
        if (!cancelled) {
          setTake(data);
          // 前のテイクで出たエラーを持ち越さない。前後移動を足した今、これが
          // 残ると読み込めた画面までエラー表示で潰れて行き止まりになる。
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [takeId]);

  const songId = take?.songId;
  useEffect(() => {
    if (!songId) return;
    const id = songId;
    let cancelled = false;
    async function load() {
      try {
        const data = await getSong(id);
        if (!cancelled) setSongContext(data);
      } catch {
        // 導線が出ないだけに留める（分析結果は既に描けている）。
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const handleRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError("");
    try {
      await submitTake(takeId);
      // status: "queued" になったことを画面に反映する（古い evaluation を
      // 出し続けないよう、submit route 側で解析結果もリセットされている）。
      const data = await getTake(takeId);
      setTake(data);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [retrying, takeId]);

  // 前後移動で takeId が変わった直後は、まだ前のテイクの state が残っている。
  // それを描くと URL と中身が食い違った分析結果を一瞬見せることになるので、
  // 読み込み中として扱う（effect で state を消すのではなく描画時に判定する）。
  const loaded = take && take.id === takeId ? take : null;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
        <Loader2 size={16} className="animate-spin" /> 読み込み中…
      </div>
    );
  }

  // 別の曲のテイクへ直接遷移した直後は songContext がまだ前の曲のもの。曲名を
  // 取り違えて出さないよう、テイクの songId と一致するときだけ使う。
  const context = songContext?.song.id === loaded.songId ? songContext : null;
  // 曲情報が取れていれば曲名とテイク名で説明を作る。取れていない間（ロード中・
  // 取得失敗）は ID の羅列にフォールバックして、画面が空にならないようにする。
  const description = context
    ? `${context.song.title} ・ ${loaded.label} ・ ${formatDateTime(loaded.recordedAt)} ・ ステータス: ${loaded.status}`
    : `テイク ${loaded.id} ・ 曲 ${loaded.songId} ・ ステータス: ${loaded.status}`;
  // 前後は描画時に導出する（effect で state に写すと、一覧とズレた隣を一瞬描く）。
  const { prev, next } = takeNeighbors(context?.takes ?? [], loaded.id);

  return (
    <div>
      <PageHeader title="分析結果（実データ）" description={description} />

      <nav className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        {prev && (
          <Link
            href={`/takes/real/${prev.id}`}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--muted)] hover:border-violet-500/50 hover:text-violet-200"
          >
            <ChevronLeft size={14} /> 前のテイク（{prev.label}）
          </Link>
        )}
        {next && (
          <Link
            href={`/takes/real/${next.id}`}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--muted)] hover:border-violet-500/50 hover:text-violet-200"
          >
            次のテイク（{next.label}）<ChevronRight size={14} />
          </Link>
        )}
        <Link
          href={`/progress?song=${loaded.songId}`}
          className="rounded-lg border border-violet-400/40 bg-violet-500/10 px-3 py-2 font-semibold text-violet-200 hover:bg-violet-500/20"
        >
          この曲の履歴を見る
        </Link>
        <Link
          href={`/songs/${loaded.songId}`}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--muted)] hover:border-violet-500/50 hover:text-violet-200"
        >
          曲の詳細
        </Link>
      </nav>

      <TakeEvaluationPanel take={loaded} />

      <TakeScoreCard songId={loaded.songId} measureScores={loaded.measureScores} />

      {loaded.status === "failed" && (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {retrying && <Loader2 size={14} className="animate-spin" />}
            再解析する
          </button>
          {retryError && <p className="text-xs text-red-300">{retryError}</p>}
        </div>
      )}

      <div className="mt-5">
        <Link href="/songs/new" className="text-xs text-violet-300 underline underline-offset-2">
          別の曲を登録する
        </Link>
      </div>
    </div>
  );
}
