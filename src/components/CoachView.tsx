"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, Send, Timer, Music2, Check, Info } from "lucide-react";
import type { Song, Take, ChatMessage } from "@/lib/mock/types";
import { Badge, Card, CardTitle } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
import { formatDate } from "@/lib/format";

const SUGGESTIONS = [
  "17〜20小節がどうしても弾けません",
  "本番まであと50日、どう配分すべき？",
  "暗譜のコツを教えて",
  "なぜテンポが走ってしまうの？",
];

const CANNED_REPLY =
  "分析データを参照して回答します。\n\n直近3テイクの傾向では、あなたは「新しい箇所の譜読みは速いが、一度身についた癖の修正に時間がかかる」タイプです。したがって、練習時間の配分は\n\n・弱点の分解練習：50%\n・通し練習：30%\n・新しい箇所：20%\n\nを推奨します。特に停滞小節（19・20小節）は、通し練習の中では改善しません。必ず単独で、テンポを大きく落として取り出してください。\n\n※ このモックでは固定の応答を返しています。本実装では Azure AI Foundry のモデルに、あなたの分析指標・テイク履歴・楽譜情報をコンテキストとして渡して生成します。";

export default function CoachView({
  songs,
  song,
  take,
  seed,
  stagnant,
}: {
  songs: Song[];
  song: Song;
  take: Take;
  seed: ChatMessage[];
  stagnant: { measure: number; delta: number; score: number }[];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(seed);
  const [input, setInput] = useState("");
  const [done, setDone] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(0);

  function send(text: string) {
    if (!text.trim()) return;
    nextId.current += 1;
    const seq = nextId.current;
    const userMsg: ChatMessage = { id: `u${seq}`, role: "user", body: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setThinking(true);
    setTimeout(() => {
      setMessages((m) => [...m, { id: `a${seq}`, role: "assistant", body: CANNED_REPLY }]);
      setThinking(false);
    }, 900);
  }

  const totalMinutes = take.aiReview.practiceMenu.reduce((a, b) => a + b.minutes, 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AIコーチ</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            分析結果と練習履歴をもとに、今日やるべきことを提案します。
          </p>
        </div>
        <SongSelector songs={songs} current={song.id} />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* --- 練習メニュー --- */}
        <div className="space-y-5 lg:col-span-3">
          <Card className="border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-transparent">
            <div className="flex items-start gap-4 p-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
                <Sparkles size={19} className="text-violet-300" />
              </div>
              <div>
                <div className="text-base font-semibold">{take.aiReview.headline}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--muted)]">
                  {take.aiReview.summary}
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle
              title="今日の練習メニュー"
              subtitle={`${formatDate(take.recordedAt)} の分析結果から生成 ・ 合計 ${totalMinutes} 分`}
              right={
                <span className="text-xs text-[var(--muted)]">
                  {done.length}/{take.aiReview.practiceMenu.length} 完了
                </span>
              }
            />
            <div className="space-y-3 p-5">
              {take.aiReview.practiceMenu.map((item, i) => {
                const isDone = done.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-4 transition-opacity ${
                      isDone
                        ? "border-green-500/30 bg-green-500/5 opacity-60"
                        : "border-[var(--border)] bg-[var(--surface-2)]"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() =>
                          setDone((d) =>
                            d.includes(item.id)
                              ? d.filter((x) => x !== item.id)
                              : [...d, item.id],
                          )
                        }
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          isDone
                            ? "border-green-500 bg-green-500 text-white"
                            : "border-[#3b4560]"
                        }`}
                      >
                        {isDone && <Check size={13} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">
                            {i + 1}. {item.title}
                          </span>
                          <Badge color="#a78bfa">
                            <Music2 size={10} className="mr-1 inline" />
                            {item.measures[0]}〜{item.measures[1]}小節
                          </Badge>
                          <Badge color="#38bdf8">♩= {item.tempoBpm}</Badge>
                          <Badge color="#8d97ad">
                            <Timer size={10} className="mr-1 inline" />
                            {item.minutes}分
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed">{item.method}</p>
                        <div className="mt-2.5 flex gap-2 rounded-md bg-[var(--surface)] px-3 py-2">
                          <Info size={12} className="mt-0.5 shrink-0 text-violet-400" />
                          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                            <strong className="text-[var(--foreground)]">なぜこの練習？</strong>{" "}
                            {item.why}
                          </p>
                        </div>
                        <Link
                          href={`/record?song=${song.id}`}
                          className="mt-2.5 inline-block text-[11px] text-violet-300 hover:text-violet-200"
                        >
                          この範囲を録音して確認する →
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardTitle title="この曲の演奏ノート" subtitle="AIが楽曲の様式・難所知識を補足" />
            <p className="p-5 text-xs leading-relaxed text-[var(--muted)]">
              {take.aiReview.context}
            </p>
          </Card>
        </div>

        {/* --- チャット --- */}
        <div className="lg:col-span-2">
          <Card className="flex h-[720px] flex-col">
            <CardTitle
              title="コーチに相談する"
              subtitle="あなたの分析データを見ながら答えます"
            />
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[88%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                      m.role === "user"
                        ? "bg-violet-600 text-white"
                        : "bg-[var(--surface-2)] text-[var(--foreground)]"
                    }`}
                  >
                    {m.body}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <div className="rounded-xl bg-[var(--surface-2)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
                    分析データを参照しています…
                  </div>
                </div>
              )}
            </div>

            {stagnant.length > 0 && (
              <div className="border-t border-[var(--border)] px-4 py-2.5 text-[10px] text-[var(--muted)]">
                参照中のデータ：{song.title} / テイク{take.label} / 停滞小節{" "}
                {stagnant
                  .slice(0, 3)
                  .map((s) => s.measure)
                  .join("・")}
              </div>
            )}

            <div className="border-t border-[var(--border)] p-3">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send(input)}
                  placeholder="気になっていることを聞いてみましょう"
                  className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs outline-none"
                />
                <button
                  onClick={() => send(input)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white hover:bg-violet-500"
                >
                  <Send size={15} />
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
