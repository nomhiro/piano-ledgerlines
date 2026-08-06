"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ScoreView from "@/components/ScoreView";

type PlaybackEvent = {
  time: number;
  name: string;
  duration: number;
  velocity: number;
};

export default function ScorePreview({
  scoreUrl,
  midiUrl,
  isDraft,
  targetTempo,
}: {
  scoreUrl: string;
  midiUrl: string | null;
  isDraft: boolean;
  targetTempo: number | null;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState("");

  const stopPlayback = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setIsPlaying(false);
  }, []);

  useEffect(() => stopPlayback, [stopPlayback]);

  async function playScore() {
    if (!midiUrl || isPlaying) return;
    setPlaybackError("");
    try {
      const [{ Midi }, Tone] = await Promise.all([import("@tonejs/midi"), import("tone")]);
      const midi = await Midi.fromUrl(midiUrl);
      const notes = midi.tracks.flatMap((track) => track.notes);
      if (notes.length === 0) throw new Error("MIDIに再生できる音符がありません。");
      const sourceTempo = midi.header.tempos[0]?.bpm ?? 120;
      const playbackTempo = targetTempo ?? sourceTempo;
      const timingScale = sourceTempo / playbackTempo;

      await Tone.start();
      const transport = Tone.getTransport();
      transport.stop();
      transport.cancel();
      transport.seconds = 0;
      const synth = new Tone.PolySynth(Tone.Synth).toDestination();
      const part = new Tone.Part<PlaybackEvent>(
        (time, event) => {
          synth.triggerAttackRelease(event.name, event.duration, time, event.velocity);
        },
        notes.map((note) => ({
          time: note.time * timingScale,
          name: note.name,
          duration: note.duration * timingScale,
          velocity: note.velocity,
        })),
      ).start(0);
      const timer = window.setTimeout(() => {
        cleanupRef.current?.();
        cleanupRef.current = null;
        setIsPlaying(false);
      }, Math.max(1, midi.duration * timingScale) * 1000 + 500);
      cleanupRef.current = () => {
        window.clearTimeout(timer);
        transport.stop();
        transport.cancel();
        part.dispose();
        synth.dispose();
      };
      transport.start();
      setIsPlaying(true);
    } catch (error) {
      stopPlayback();
      setPlaybackError(error instanceof Error ? error.message : "MIDIの再生を開始できませんでした。");
    }
  }

  return (
    <section className="mt-5" aria-labelledby="score-preview-title">
      <h2 id="score-preview-title" className="mb-3 text-lg font-semibold">変換後の楽譜</h2>
      {isDraft && (
        <p role="note" className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          PDFからの自動変換ドラフトです。原本と比較するためのプレビューであり、演奏分析には使用しません。
        </p>
      )}
      <ScoreView scoreUrl={scoreUrl} showHeatmap={false} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void playScore()}
          disabled={!midiUrl || isPlaying}
          className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-violet-600/40"
        >
          {isPlaying ? "再生中" : "楽譜を再生"}
        </button>
        <button
          type="button"
          onClick={stopPlayback}
          disabled={!isPlaying}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:border-violet-500/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          停止
        </button>
        {!midiUrl && <p className="text-sm text-[var(--muted)]">この楽譜のMIDIプレビューは生成できませんでした。</p>}
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        再生ボタンを押すと、変換した楽譜から生成したMIDIを
        {targetTempo ? ` ♩=${targetTempo} ` : " 楽譜のテンポ "}
        でブラウザ内のシンセが再生します。
      </p>
      {playbackError && <p role="alert" className="mt-2 text-sm text-red-300">{playbackError}</p>}
    </section>
  );
}
