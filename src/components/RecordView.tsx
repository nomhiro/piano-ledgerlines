"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Square, Loader2, Check, Music4, Volume2, AlertTriangle } from "lucide-react";
import type { Song, Take } from "@/lib/mock/types";
import { Badge, Card, CardTitle } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
import { formatDuration } from "@/lib/format";
import { createTake, submitTake, subscribeTakeEvents, uploadTakeAudio } from "@/lib/api/client";

type Phase = "setup" | "countin" | "recording" | "uploading" | "analyzing" | "done" | "error";

const ANALYSIS_STEPS = [
  { label: "音声をアップロード中", detail: "ローカルストレージ（本番はAzure Blob Storage）" },
  { label: "AIで採譜中（音声 → MIDI）", detail: "ピアノ特化の自動採譜モデル / ペダル・ベロシティも推定" },
  { label: "楽譜とアライメント中", detail: "DTWで演奏音符と楽譜音符を1対1に対応付け" },
  { label: "5指標を小節ごとに算出中", detail: "音程 / リズム / テンポ / 強弱 / ペダル" },
];

// モックモードの疑似進捗ステップ（実モードは実際のワーカーの status に応じて表示する）
const MOCK_ANALYSIS_STEPS = [
  ...ANALYSIS_STEPS,
  { label: "AIコーチが講評と練習メニューを生成中", detail: "Azure AI Foundry" },
];

const STATUS_STEP_INDEX: Record<string, number> = {
  queued: 0,
  transcribing: 1,
  aligning: 2,
  scoring: 3,
  completed: 4,
};

export default function RecordView({
  songs,
  song,
  latestTake,
  real = false,
}: {
  songs: Song[];
  song: Song;
  latestTake: Take | undefined;
  real?: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("setup");
  const [elapsed, setElapsed] = useState(0);
  const [countIn, setCountIn] = useState(3);
  const [step, setStep] = useState(0);
  const [metronome, setMetronome] = useState(true);
  const [tempo, setTempo] = useState(song.currentTempo);
  const [from, setFrom] = useState(latestTake?.measureRange[0] ?? 1);
  const [to, setTo] = useState(latestTake?.measureRange[1] ?? Math.max(1, song.totalMeasures));
  const [level, setLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [realTakeId, setRealTakeId] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const recordStartedAt = useRef<string>("");
  const unsubscribeEvents = useRef<() => void>(() => {});

  useEffect(() => {
    return () => {
      timers.current.forEach(clearInterval);
      unsubscribeEvents.current();
      mediaStream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    if (real) {
      try {
        mediaStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setErrorMessage("マイクへのアクセスが許可されませんでした。ブラウザの設定を確認してください。");
        setPhase("error");
        return;
      }
    }

    setPhase("countin");
    setCountIn(3);
    let c = 3;
    const t = setInterval(() => {
      c -= 1;
      setCountIn(c);
      if (c <= 0) {
        clearInterval(t);
        setPhase("recording");
        setElapsed(0);
        recordStartedAt.current = new Date().toISOString();

        if (real && mediaStream.current) {
          recordedChunks.current = [];
          const mr = new MediaRecorder(mediaStream.current);
          mr.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.current.push(e.data);
          };
          mediaRecorder.current = mr;
          mr.start();
        }

        const t2 = setInterval(() => setElapsed((e) => e + 1), 1000);
        const t3 = setInterval(() => setLevel(Math.random()), 120);
        timers.current.push(t2, t3);
      }
    }, 900);
    timers.current.push(t);
  }

  function stop() {
    timers.current.forEach(clearInterval);
    timers.current = [];

    if (real) {
      void stopReal();
      return;
    }

    setPhase("uploading");
    setStep(0);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setStep(i);
      if (i === 1) setPhase("analyzing");
      if (i >= MOCK_ANALYSIS_STEPS.length) {
        clearInterval(t);
        setPhase("done");
      }
    }, 1100);
    timers.current.push(t);
  }

  async function stopReal() {
    const mr = mediaRecorder.current;
    const durationSec = elapsed;
    setPhase("uploading");
    setStep(0);

    try {
      const blob: Blob = await new Promise((resolve, reject) => {
        if (!mr) {
          reject(new Error("録音デバイスが初期化されていません"));
          return;
        }
        mr.onstop = () => {
          resolve(new Blob(recordedChunks.current, { type: mr.mimeType || "audio/webm" }));
        };
        mr.stop();
      });
      mediaStream.current?.getTracks().forEach((t) => t.stop());

      // 1. テイクを作成 (api.md 5.2 `POST /songs/{songId}/takes` 相当)
      const created = await createTake(song.id, {
        label: `${from}-${to}小節 ・ ♩=${tempo}`,
        recordedAt: recordStartedAt.current,
        durationSec,
        requestedMeasureRange: [from, to],
        requestedTempo: tempo,
        inputKind: "audio",
        contentType: blob.type || "audio/webm",
      });
      setRealTakeId(created.takeId);
      setStep(1);

      // 2. 録音データをアップロード
      const ext = blob.type.includes("webm") ? "webm" : "ogg";
      await uploadTakeAudio(created.takeId, blob, `take.${ext}`);

      // 3. 解析を投入 (202 Accepted、非同期でワーカーが実行される)
      await submitTake(created.takeId);
      setPhase("analyzing");
      setStep(2);

      // 4. SSEで進捗を購読
      unsubscribeEvents.current = subscribeTakeEvents(
        created.takeId,
        (data) => {
          const idx = STATUS_STEP_INDEX[data.status];
          if (idx !== undefined) setStep(Math.min(idx, ANALYSIS_STEPS.length - 1));
        },
        () => {
          setStep(ANALYSIS_STEPS.length);
          setPhase("done");
        }
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  const steps = real ? ANALYSIS_STEPS : MOCK_ANALYSIS_STEPS;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">演奏を録音する</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {real
              ? "実際にマイクで録音し、実バックエンドAPIで解析します（縦串フェーズ）。"
              : "アコースティックピアノでもOK。スマホやPCのマイクで録音するだけで分析します。"}
          </p>
        </div>
        <SongSelector songs={songs} current={song.id} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle
            title={song.title}
            subtitle={`${song.composer} ・ ${song.timeSignature} ・ 全${song.totalMeasures}小節`}
            right={<Badge color={song.accent}>{from}〜{to} 小節</Badge>}
          />

          <div className="flex flex-col items-center justify-center gap-6 px-5 py-12">
            {phase === "setup" && (
              <>
                <button
                  onClick={start}
                  className="flex h-28 w-28 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105"
                >
                  <Mic size={40} />
                </button>
                <p className="text-sm text-[var(--muted)]">
                  {real
                    ? "タップするとマイクの利用許可を求め、3カウント後に録音を開始します"
                    : "タップすると3カウント後に録音を開始します"}
                </p>
              </>
            )}

            {phase === "countin" && (
              <>
                <div className="flex h-28 w-28 items-center justify-center rounded-full border-4 border-violet-500 text-5xl font-bold text-violet-300">
                  {countIn > 0 ? countIn : "!"}
                </div>
                <p className="text-sm text-[var(--muted)]">カウントイン…</p>
              </>
            )}

            {phase === "recording" && (
              <>
                <button
                  onClick={stop}
                  className="recording-pulse flex h-28 w-28 items-center justify-center rounded-full bg-red-500 text-white"
                >
                  <Square size={34} fill="white" />
                </button>
                <div className="text-3xl font-semibold tabular-nums">
                  {formatDuration(elapsed)}
                </div>
                <div className="flex h-10 items-end gap-1">
                  {Array.from({ length: 32 }).map((_, i) => {
                    const h = 6 + Math.abs(Math.sin((i + elapsed) * 0.7)) * 30 * (0.4 + level);
                    return (
                      <span
                        key={i}
                        className="w-1.5 rounded-full bg-red-400/80"
                        style={{ height: `${h}px` }}
                      />
                    );
                  })}
                </div>
                <p className="text-sm text-[var(--muted)]">
                  録音中… 弾き終わったら停止してください
                </p>
              </>
            )}

            {(phase === "uploading" || phase === "analyzing") && (
              <div className="w-full max-w-lg">
                <div className="mb-6 flex flex-col items-center gap-2">
                  <Loader2 size={38} className="animate-spin text-violet-400" />
                  <p className="text-sm">演奏を分析しています…</p>
                  <p className="text-xs text-[var(--muted)]">
                    {real
                      ? "実際のPythonワーカー（採譜・アライメント・指標算出）が動作しています。数十秒〜数分かかる場合があります。"
                      : "通常30秒〜1分で完了します。閉じても分析は継続します。"}
                  </p>
                </div>
                <div className="space-y-3">
                  {steps.map((s, i) => (
                    <div key={s.label} className="flex items-start gap-3">
                      {i < step ? (
                        <Check size={16} className="mt-0.5 text-green-400" />
                      ) : i === step ? (
                        <Loader2 size={16} className="mt-0.5 animate-spin text-violet-400" />
                      ) : (
                        <span className="mt-1 inline-block h-3.5 w-3.5 rounded-full border border-[#3b4560]" />
                      )}
                      <div>
                        <div className={`text-sm ${i <= step ? "" : "text-[var(--muted)]"}`}>
                          {s.label}
                        </div>
                        <div className="text-[11px] text-[var(--muted)]">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phase === "error" && (
              <div className="flex w-full max-w-lg flex-col items-center gap-4">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/20">
                  <AlertTriangle size={38} className="text-red-400" />
                </div>
                <p className="text-center text-sm text-red-300">{errorMessage}</p>
                <button
                  onClick={() => setPhase("setup")}
                  className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted)]"
                >
                  もう一度試す
                </button>
              </div>
            )}

            {phase === "done" && (
              <div className="flex w-full max-w-lg flex-col items-center gap-4">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
                  <Check size={38} className="text-green-400" />
                </div>
                <p className="text-sm">分析が完了しました</p>
                {!real && (
                  <p className="text-center text-xs leading-relaxed text-[var(--muted)]">
                    ※ このモックでは、直近のテイクの分析結果を表示します。
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (real && realTakeId) router.push(`/takes/real/${realTakeId}`);
                      else if (latestTake) router.push(`/takes/${latestTake.id}`);
                    }}
                    className="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
                  >
                    分析結果を見る
                  </button>
                  <button
                    onClick={() => setPhase("setup")}
                    className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted)]"
                  >
                    もう一度録音する
                  </button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardTitle title="録音設定" />
            <div className="space-y-5 p-5">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-[var(--muted)]">練習する範囲</span>
                  <span className="tabular-nums">
                    {from} 〜 {to} 小節
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={song.totalMeasures}
                    value={from}
                    onChange={(e) => setFrom(Number(e.target.value))}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
                  />
                  <span className="text-[var(--muted)]">〜</span>
                  <input
                    type="number"
                    min={1}
                    max={song.totalMeasures}
                    value={to}
                    onChange={(e) => setTo(Number(e.target.value))}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
                  />
                </div>
                <div className="mt-2 flex gap-1.5">
                  <QuickBtn onClick={() => { setFrom(1); setTo(song.totalMeasures); }}>
                    全体
                  </QuickBtn>
                  <QuickBtn onClick={() => { setFrom(17); setTo(20); }}>難所 17-20</QuickBtn>
                  <QuickBtn onClick={() => { setFrom(1); setTo(16); }}>前半</QuickBtn>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-[var(--muted)]">テンポ</span>
                  <span className="tabular-nums">♩= {tempo}</span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={200}
                  value={tempo}
                  onChange={(e) => setTempo(Number(e.target.value))}
                  className="w-full accent-violet-500"
                />
                <div className="mt-1 flex justify-between text-[10px] text-[var(--muted)]">
                  <span>現在 {song.currentTempo}</span>
                  <span>目標 {song.targetTempo}</span>
                </div>
              </div>

              <label className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2">
                  <Volume2 size={14} className="text-[var(--muted)]" />
                  メトロノームを鳴らす
                </span>
                <input
                  type="checkbox"
                  checked={metronome}
                  onChange={(e) => setMetronome(e.target.checked)}
                  className="h-4 w-4 accent-violet-500"
                />
              </label>

              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
                <Music4 size={13} className="mb-1 inline text-violet-400" /> 電子ピアノをお使いの場合はMIDI接続でより高精度に分析できますが、
                <strong className="text-[var(--foreground)]">マイク録音だけでも全機能が使えます</strong>。
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="録音のコツ" />
            <ul className="space-y-2 p-5 text-[11px] leading-relaxed text-[var(--muted)]">
              <li>・スマホは譜面台の上など、ピアノから50cm〜1m程度の位置に置いてください。</li>
              <li>・エアコンやテレビなど、定常的な騒音は事前に止めると精度が上がります。</li>
              <li>・止まってしまっても大丈夫です。止まった箇所も分析対象になります。</li>
              <li>・部分練習でも記録されます。難所だけ繰り返し録音するのが効果的です。</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function QuickBtn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
    >
      {children}
    </button>
  );
}
