"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileMusic, Upload, Check, Loader2, ScanLine, Info, AlertTriangle } from "lucide-react";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { createSong, uploadScore } from "@/lib/api/client";

type Phase = "idle" | "uploading" | "parsing" | "done" | "error";

const STEPS = [
  "ファイルをアップロード中…",
  "MusicXML を解析中（パート / 声部 / 小節を抽出）",
  "小節・拍・音符のインデックスを作成中",
];

export default function NewSongPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState("");
  const [title, setTitle] = useState("");
  const [composer, setComposer] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [targetTempo, setTargetTempo] = useState(120);
  const [songId, setSongId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [scoreInfo, setScoreInfo] = useState<{
    measureCount: number;
    timeSignature: string;
    keySignature: string;
    detectedTempo: number;
    warnings: { code: string; message: string }[];
  } | null>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    setPhase("uploading");
    setStep(0);
    setErrorMessage("");

    const derivedTitle = title || file.name.replace(/\.(musicxml|xml|mxl|mid|midi)$/i, "");
    setTitle(derivedTitle);

    try {
      // 1. 曲メタデータを作成 (api.md 5.1 `POST /songs` 相当)
      const created = await createSong({
        title: derivedTitle,
        composer: composer || "不明",
        targetTempo,
      });
      setSongId(created.songId);
      setStep(1);
      setPhase("parsing");

      // 2. 楽譜ファイルをアップロードし、サーバー側でreference.jsonを生成
      //    (api.md 5.1 `POST /songs/{songId}/score`、実際はPythonワーカーが
      //    music21でMusicXMLを解析する。同期処理で通常数秒)
      const result = await uploadScore(created.songId, file);
      setStep(STEPS.length);
      setScoreInfo({
        measureCount: result.measureCount,
        timeSignature: result.timeSignature,
        keySignature: result.keySignature,
        detectedTempo: result.detectedTempo,
        warnings: result.warnings,
      });
      setPhase("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div>
      <PageHeader
        title="曲を追加"
        description="お手持ちの楽譜データを登録します。演奏の照合にはデジタル楽譜（MusicXML / MIDI）が必要です。"
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardTitle title="楽譜を取り込む" />
            <div className="p-5">
              {phase === "idle" ? (
                <>
                  <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[#3b4560] bg-[var(--surface-2)] px-6 py-12 text-center transition-colors hover:border-violet-500">
                    <Upload size={30} className="text-violet-400" />
                    <div>
                      <div className="text-sm font-medium">
                        MusicXML / MXL / MIDI ファイルをドロップ
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        またはクリックしてファイルを選択
                      </div>
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      accept=".musicxml,.xml,.mxl,.mid,.midi"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleFile(f);
                      }}
                    />
                  </label>
                  <div className="mt-3 text-center">
                    <button
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
                <div className="space-y-3">
                  <div className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                    <FileMusic size={18} className="text-violet-400" />
                    <span className="text-sm">{fileName}</span>
                    {phase === "done" && <Badge color="#22c55e">解析完了</Badge>}
                    {phase === "error" && <Badge color="#ef4444">失敗</Badge>}
                  </div>
                  {phase !== "error" &&
                    STEPS.map((s, i) => (
                      <div key={s} className="flex items-center gap-2.5 px-1 text-xs">
                        {i < step ? (
                          <Check size={15} className="text-green-400" />
                        ) : i === step ? (
                          <Loader2 size={15} className="animate-spin text-violet-400" />
                        ) : (
                          <span className="inline-block h-[15px] w-[15px] rounded-full border border-[#3b4560]" />
                        )}
                        <span className={i <= step ? "" : "text-[var(--muted)]"}>{s}</span>
                      </div>
                    ))}
                  {phase === "done" && scoreInfo && (
                    <div className="rounded-lg border border-green-500/25 bg-green-500/10 p-4 text-xs">
                      <div className="font-semibold text-green-300">
                        {scoreInfo.measureCount}小節 / {scoreInfo.timeSignature} / {scoreInfo.keySignature} を認識しました
                      </div>
                      <div className="mt-1 text-[var(--muted)]">
                        検出テンポ ♩= {scoreInfo.detectedTempo}。
                        これが分析時の「理想の演奏」の基準になります。
                      </div>
                      {scoreInfo.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1 text-amber-300">
                          {scoreInfo.warnings.map((w, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                              <span>{w.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {phase === "error" && (
                    <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-4 text-xs text-red-300">
                      {errorMessage}
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
                  <option>白鳥 玲子 先生と共有する</option>
                  <option>共有しない</option>
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
                disabled={phase !== "done" || !songId}
                onClick={() => songId && router.push(`/record?song=${songId}`)}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                  phase === "done" && songId
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
                <ScanLine size={20} className="mt-0.5 shrink-0 text-[var(--muted)]" />
                <div>
                  <div className="flex items-center gap-2 text-sm">
                    OMR（光学楽譜認識）
                    <Badge color="#f59e0b">開発中</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
                    紙の楽譜をスマホで撮影、またはPDFをアップロードするとMusicXMLに自動変換します。
                    MVPではMusicXMLの直接アップロードのみ対応し、OMRは次フェーズで追加予定です。
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="なぜ楽譜データが必要？" />
            <div className="space-y-3 p-5 text-xs leading-relaxed text-[var(--muted)]">
              <div className="flex gap-2">
                <Info size={14} className="mt-0.5 shrink-0 text-violet-400" />
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
