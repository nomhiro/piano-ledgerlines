"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileMusic, Upload, Check, Loader2, ScanLine, Info, AlertTriangle } from "lucide-react";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { createSong, uploadScore } from "@/lib/api/client";
import { useSongScoreProgress } from "@/lib/hooks/useSongScoreProgress";

type Phase = "idle" | "uploading" | "converting" | "reviewing" | "parsing" | "done" | "error";

const STEPS = [
  "ファイルをアップロード中…",
  "MusicXML を解析中（パート / 声部 / 小節を抽出）",
  "小節・拍・音符のインデックスを作成中",
];

export default function NewSongPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [fileName, setFileName] = useState("");
  const [title, setTitle] = useState("");
  const [composer, setComposer] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [targetTempo, setTargetTempo] = useState(120);
  const [songId, setSongId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [watchedSongId, setWatchedSongId] = useState<string | null>(null);
  const progress = useSongScoreProgress(watchedSongId);

  // parsing 中は SSE の結果をそのまま画面の状態として使う（別の state にコピーしない）。
  // "done" になるのは parsing 経由のときだけなので、scoreInfo 用の state は持たない。
  // phase / errorMessage は、parsing を経由しない他の分岐（PDF変換・エラー等）のために
  // そのまま残す。
  const displayPhase: Phase =
    phase === "parsing"
      ? progress.status === "ready"
        ? "done"
        : progress.failureMessage
          ? "error"
          : "parsing"
      : phase;
  const displayScoreInfo = phase === "parsing" ? progress.info : null;
  const displayErrorMessage = phase === "parsing" ? progress.failureMessage ?? "" : errorMessage;

  // 進捗のチェックは「実際に終わった段階」だけを示す。state に持たず displayPhase
  // から導出するので、まだ解析していない段階にチェックが付くことがない。
  // uploading: STEPS[0]（アップロード中）を回す。
  // parsing: アップロードは完了、ワーカーが STEPS[1] を実行中。
  // done: reference.json が出来ている（= 全段階が完了）。
  const displayStep =
    displayPhase === "done" ? STEPS.length : displayPhase === "parsing" ? 1 : 0;

  async function handleFile(file: File) {
    setFileName(file.name);
    setPhase("uploading");
    setErrorMessage("");

    const derivedTitle = title || file.name.replace(/\.(musicxml|xml|mxl|mid|midi|pdf)$/i, "");
    setTitle(derivedTitle);

    try {
      // 1. 曲メタデータを作成 (api.md 5.1 `POST /songs` 相当)
      const created = await createSong({
        title: derivedTitle,
        composer: composer || "不明",
        targetTempo,
      });
      setSongId(created.songId);

      // 2. 楽譜ファイルを送信する。最大10MBのマルチパートなので、送っている間は
      //    まだ「受け付けられた」とは言えない。phase は uploading のまま維持し、
      //    202 が返ってから parsing に進む（api.md 5.1 は 202 + 進捗の購読）。
      const result = await uploadScore(created.songId, file);
      if (result.status === "converting_score") {
        setPhase("converting");
        return;
      }
      if (result.status === "reviewing_score") {
        setPhase("reviewing");
        return;
      }
      if (result.status === "omr_failed") {
        setErrorMessage(result.omrError ?? "PDF楽譜をMusicXMLへ変換できませんでした。");
        setPhase("error");
        return;
      }
      // 参照譜の生成はワーカーが行う。受け付けられたので parsing に進み、
      // SSE の結果を待つ。
      setWatchedSongId(created.songId);
      setPhase("parsing");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div>
      <PageHeader
        title="曲を追加"
        description="MusicXML・MIDI、またはPDFの印刷譜を登録します。PDFの自動変換結果はプレビュー専用で、演奏分析には正確なデジタル楽譜が必要です。"
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardTitle title="楽譜を取り込む" />
            <div className="p-5">
              {displayPhase === "idle" ? (
                <>
                  <div className="relative">
                    <input
                      id="score-file-input"
                      type="file"
                      className="peer sr-only"
                      accept=".musicxml,.xml,.mxl,.mid,.midi,.pdf,application/pdf"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleFile(f);
                      }}
                    />
                    <label htmlFor="score-file-input" className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[#3b4560] bg-[var(--surface-2)] px-6 py-12 text-center transition-colors hover:border-violet-500 peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-violet-300">
                    <Upload size={30} className="text-violet-400" aria-hidden="true" />
                    <div>
                      <div className="text-sm font-medium">
                        MusicXML / MXL / MIDI / PDF ファイルをドロップ
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        またはクリックしてファイルを選択
                      </div>
                    </div>
                    </label>
                  </div>
                  <div className="mt-3 text-center">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await fetch("/scores/etude-in-a-minor.musicxml");
                        const blob = await res.blob();
                        const file = new File([blob], "etude-in-a-minor.musicxml", {
                          type: "application/vnd.recordare.musicxml+xml",
                        });
                        void handleFile(file);
                      }}
                      className="text-xs text-violet-300 underline underline-offset-2"
                    >
                      サンプルファイルで試す（実データ / 実APIで解析）
                    </button>
                  </div>
                </>
              ) : (
                <div
                  className="space-y-3"
                  role={displayPhase === "error" ? "alert" : "status"}
                  aria-live={displayPhase === "error" ? "assertive" : "polite"}
                  aria-busy={displayPhase === "uploading" || displayPhase === "parsing" || displayPhase === "converting"}
                >
                  <div className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                    <FileMusic size={18} className="text-violet-400" aria-hidden="true" />
                    <span className="text-sm">{fileName}</span>
                    {displayPhase === "done" && <Badge color="#22c55e">解析完了</Badge>}
                    {displayPhase === "error" && <Badge color="#ef4444">失敗</Badge>}
                  </div>
                  {displayPhase === "converting" && (
                    <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-4 text-xs text-violet-200">
                      PDF楽譜をAudiverisでMusicXMLに変換しています。完了後、この画面を再読み込みして変換結果を確認してください。
                    </div>
                  )}
                  {displayPhase === "reviewing" && (
                    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-xs text-amber-100">
                      <p>PDFからMusicXMLへの変換が完了しました。これは原本との比較用プレビューであり、演奏分析には使用できません。</p>
                      <button
                        type="button"
                        onClick={() => songId && router.push(`/songs/${songId}`)}
                        className="mt-3 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500"
                      >
                        曲の詳細で確認する
                      </button>
                    </div>
                  )}
                  {displayPhase !== "error" && displayPhase !== "reviewing" && displayPhase !== "converting" &&
                    STEPS.map((s, i) => (
                      <div key={s} className="flex items-center gap-2.5 px-1 text-xs">
                        {i < displayStep ? (
                          <Check size={15} className="text-green-400" aria-hidden="true" />
                        ) : i === displayStep ? (
                          <Loader2 size={15} className="animate-spin text-violet-400" aria-hidden="true" />
                        ) : (
                          <span className="inline-block h-[15px] w-[15px] rounded-full border border-[#3b4560]" />
                        )}
                        <span className={i <= displayStep ? "" : "text-[var(--muted)]"}>{s}</span>
                      </div>
                    ))}
                  {displayPhase === "done" && displayScoreInfo && (
                    <div className="rounded-lg border border-green-500/25 bg-green-500/10 p-4 text-xs">
                      <div className="font-semibold text-green-300">
                        {displayScoreInfo.measureCount}小節 / {displayScoreInfo.timeSignature} / {displayScoreInfo.keySignature} を認識しました
                      </div>
                      <div className="mt-1 text-[var(--muted)]">
                        検出テンポ ♩= {displayScoreInfo.detectedTempo}。
                        これが分析時の「理想の演奏」の基準になります。
                      </div>
                      {displayScoreInfo.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1 text-amber-300">
                          {displayScoreInfo.warnings.map((w, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                              <span>{w.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {displayPhase === "parsing" && (
                    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-xs text-amber-200">
                      楽譜を受け付けました。解析ワーカーが小節・拍子・調を抽出しています。この画面のまま少しお待ちください。
                    </div>
                  )}
                  {displayPhase === "error" && (
                    <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-4 text-xs text-red-300">
                      <p>{displayErrorMessage}</p>
                      {/* この画面でのやり直しは createSong から始まって曲が重複作成
                          されるため、既に作られた曲の詳細へ送る。差し替えは
                          そこから同じ曲に対して行える。 */}
                      {songId && (
                        <p className="mt-2">
                          <Link
                            href={`/songs/${songId}`}
                            className="text-red-200 underline underline-offset-2"
                          >
                            曲の詳細を開いて楽譜を差し替える
                          </Link>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle title="曲の情報と目標" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="曲名">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="ワルツ 第7番 嬰ハ短調"
                  className="input"
                />
              </Field>
              <Field label="作曲者">
                <input
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="F. Chopin"
                  className="input"
                />
              </Field>
              <Field label="目標日（発表会・レッスンなど）">
                <input
                  type="date"
                  value={goalDate}
                  onChange={(e) => setGoalDate(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label={`目標テンポ ♩= ${targetTempo}`}>
                <input
                  type="range"
                  min={40}
                  max={200}
                  value={targetTempo}
                  onChange={(e) => setTargetTempo(Number(e.target.value))}
                  className="w-full accent-violet-500"
                />
              </Field>
              <Field label="ゴールの状態">
                <select className="input">
                  <option>暗譜して通し演奏できる</option>
                  <option>ノーミスで通せる</option>
                  <option>譜読みを終える</option>
                  <option>目標テンポで弾ける</option>
                </select>
              </Field>
              <Field label="先生と共有">
                <select className="input">
                  <option>共有しない</option>
                  <option>教室の先生と共有する</option>
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
              <Link
                href="/songs"
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)]"
              >
                キャンセル
              </Link>
              <button
                type="button"
                disabled={displayPhase !== "done" || !songId}
                onClick={() => songId && router.push(`/record?song=${songId}`)}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                  displayPhase === "done" && songId
                    ? "bg-violet-600 hover:bg-violet-500"
                    : "pointer-events-none bg-violet-600/40"
                }`}
              >
                この曲を登録して録音へ進む
              </button>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardTitle title="PDF・紙の楽譜から取り込む" />
            <div className="p-5">
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-[#3b4560] bg-[var(--surface-2)] p-4">
                <ScanLine size={20} className="mt-0.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                <div>
                  <div className="flex items-center gap-2 text-sm">
                    OMR（光学楽譜認識）
                    <Badge color="#8b5cf6">Audiveris</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
                    印刷されたPDF楽譜をアップロードすると、AudiverisでMusicXMLに変換します。
                    認識結果は誤りを含む場合があるため、確認・承認後に演奏分析へ使用します。手書き譜・写真は対応していません。
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="なぜ楽譜データが必要？" />
            <div className="space-y-3 p-5 text-xs leading-relaxed text-[var(--muted)]">
              <div className="flex gap-2">
                <Info size={14} className="mt-0.5 shrink-0 text-violet-400" aria-hidden="true" />
                <p>
                  録音した音声はAIで採譜され、<strong className="text-[var(--foreground)]">楽譜データと1音ずつ照合</strong>されます。
                  これにより「どの小節のどの音がどう違ったか」を特定できます。
                </p>
              </div>
              <p>
                さらに、楽譜に書かれた強弱記号・テンポ記号・スラー・ペダル記号を「理想の演奏」の基準として使うため、
                単なる音符の正誤ではなく<strong className="text-[var(--foreground)]">表現の再現度</strong>まで評価できます。
              </p>
              <p>
                アップロードされた楽譜は本人の練習分析にのみ使用され、他ユーザーへの配信は行いません。
              </p>
            </div>
          </Card>
        </div>
      </div>

      <style>{`
        .input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid var(--border);
          background: var(--surface-2);
          padding: 0.5rem 0.75rem;
          font-size: 0.8125rem;
          outline: none;
          color: var(--foreground);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}
