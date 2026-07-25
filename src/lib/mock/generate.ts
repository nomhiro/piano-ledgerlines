import type {
  AiReview,
  Issue,
  IssueType,
  MeasureScore,
  MetricKey,
  RollNote,
  Severity,
  Take,
} from "./types";
import { METRIC_KEYS } from "./types";

/** 決定的な擬似乱数（SSR/CSRで同じ値になるようシード固定） */
export function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 10) / 10;

export interface TakeSpec {
  id: string;
  songId: string;
  label: string;
  recordedAt: string;
  /** 全体の習熟度 0-1。テイクが進むほど上がる */
  mastery: number;
  measureRange: [number, number];
  tempoBpm: number;
  targetTempo: number;
  durationSec: number;
  memo: string;
  seed: number;
  /** なかなか良くならない小節（練習の停滞ポイント） */
  stubbornMeasures: number[];
  /** 元々の難所。習熟度に応じて改善する */
  weakMeasures: number[];
  metricBias: Partial<Record<MetricKey, number>>;
  aiReview: AiReview;
}

function measureScoreFor(
  spec: TakeSpec,
  measure: number,
  rng: () => number,
): MeasureScore {
  const base = 52 + spec.mastery * 44;
  let score = base + (rng() - 0.5) * 9;

  if (spec.weakMeasures.includes(measure)) {
    // 難所は最初大きく凹み、習熟度とともに回復する
    score -= 26 * (1 - spec.mastery * 0.85);
  }
  if (spec.stubbornMeasures.includes(measure)) {
    // 停滞小節は習熟度が上がってもほとんど改善しない（全体の伸びから切り離す）
    score = 46 + spec.mastery * 4 + (rng() - 0.5) * 4;
  }
  score = clamp(score, 18, 99);

  const metrics = {} as Record<MetricKey, number>;
  for (const key of METRIC_KEYS) {
    const bias = spec.metricBias[key] ?? 0;
    metrics[key] = round(clamp(score + bias + (rng() - 0.5) * 12, 15, 100));
  }
  return { measure, score: round(score), metrics };
}

const ISSUE_TEMPLATES: Record<
  IssueType,
  (m: number, beat: number) => { title: string; detail: string }
> = {
  "missed-note": (m, b) => ({
    title: `${m}小節 ${b}拍目：内声の音が抜けています`,
    detail:
      "右手の和音の中声部（Aの音）が発音されていません。手首が外側に逃げて2〜3の指が浅くなっているのが原因と考えられます。和音だけを取り出し、内声だけをフォルテで弾く練習が有効です。",
  }),
  "extra-note": (m, b) => ({
    title: `${m}小節 ${b}拍目：譜面にない音が鳴っています`,
    detail:
      "隣接鍵（半音下）を同時に触れています。跳躍の着地で手が広がりすぎているサイン。着地点だけを繰り返し、目を閉じても位置が取れるようにしましょう。",
  }),
  timing: (m, b) => ({
    title: `${m}小節 ${b}拍目：発音が平均 +38ms 遅れています`,
    detail:
      "左手の分散和音に対して右手のメロディが恒常的に遅れています。無意識のアルペジオ癖です。両手を完全に同時に、和音として掴む練習をしてから戻してください。",
  }),
  dynamics: (m) => ({
    title: `${m}小節：cresc. が途中で頭打ちになっています`,
    detail:
      "指示は 4小節かけての cresc. ですが、実測では2小節目で最大音量に達し、以降フラットです。開始をもっと小さく取り、到達点を後ろに設計しましょう。",
  }),
  pedal: (m) => ({
    title: `${m}小節：ペダルの踏み替えが 0.2 拍遅く、和声が濁っています`,
    detail:
      "和声が変わる拍頭で前の響きが残っています。踏み替えを「音を弾いた直後」に合わせる意識に変えると解消します。",
  }),
  tempo: (m) => ({
    title: `${m}小節：無意識に加速しています（+9 BPM）`,
    detail:
      "16分音符が続く箇所で走る傾向。ここだけメトロノームを裏拍で鳴らして練習すると安定します。",
  }),
};

function buildIssues(spec: TakeSpec, measures: MeasureScore[]): Issue[] {
  const rng = makeRng(spec.seed + 7);
  const sorted = [...measures].sort((a, b) => a.score - b.score);
  const targets = sorted.slice(0, Math.max(3, Math.round(9 - spec.mastery * 5)));
  const types: IssueType[] = [
    "missed-note",
    "timing",
    "pedal",
    "dynamics",
    "extra-note",
    "tempo",
  ];
  return targets.map((m, i) => {
    const type = types[i % types.length];
    const beat = 1 + Math.floor(rng() * 3);
    const severity: Severity = m.score < 45 ? "high" : m.score < 65 ? "medium" : "low";
    const { title, detail } = ISSUE_TEMPLATES[type](m.measure, beat);
    return {
      id: `${spec.id}-issue-${i}`,
      measure: m.measure,
      beat,
      type,
      severity,
      title,
      detail,
    };
  });
}

function buildTempoCurve(spec: TakeSpec, measures: MeasureScore[]) {
  const rng = makeRng(spec.seed + 11);
  return measures.map((m) => {
    const wobble = (1 - spec.mastery) * 14;
    const drift = spec.weakMeasures.includes(m.measure) ? -6 * (1 - spec.mastery) : 0;
    const rush = spec.stubbornMeasures.includes(m.measure) ? 8 : 0;
    return {
      measure: m.measure,
      bpm: Math.round(spec.tempoBpm + drift + rush + (rng() - 0.5) * wobble),
      target: spec.tempoBpm,
    };
  });
}

function buildDynamicsCurve(spec: TakeSpec, measures: MeasureScore[]) {
  const rng = makeRng(spec.seed + 13);
  const n = measures.length;
  return measures.map((m, i) => {
    // 理想: 山なりのフレージング
    const phase = (i / Math.max(1, n - 1)) * Math.PI;
    const target = 52 + Math.sin(phase) * 22;
    const flatten = 1 - spec.mastery * 0.75; // 未熟なほど平坦
    const actual = target - (target - 56) * flatten + (rng() - 0.5) * 7;
    return {
      measure: m.measure,
      actual: round(clamp(actual, 20, 95)),
      target: round(target),
    };
  });
}

const SCALE = [0, 2, 4, 5, 7, 9, 11];

function buildRoll(spec: TakeSpec, measures: MeasureScore[]): RollNote[] {
  const rng = makeRng(spec.seed + 17);
  const notes: RollNote[] = [];
  const beatsPerMeasure = 3;
  measures.forEach((m, mi) => {
    const bad = m.score < 60;
    // 右手：メロディ
    for (let b = 0; b < beatsPerMeasure; b++) {
      const deg = Math.floor(rng() * 7);
      const midi = 72 + SCALE[deg] + (rng() > 0.8 ? 12 : 0);
      let status: RollNote["status"] = "correct";
      const r = rng();
      if (bad && r > 0.72) status = "missed";
      else if (bad && r > 0.62) status = "late";
      else if (r > 0.96) status = "early";
      notes.push({
        id: `${spec.id}-r-${mi}-${b}`,
        measure: m.measure,
        startBeat: mi * beatsPerMeasure + b,
        durationBeats: 0.9,
        midi,
        hand: "R",
        status,
        velocity: Math.round(60 + rng() * 45 * (bad ? 0.7 : 1)),
      });
    }
    if (bad && rng() > 0.6) {
      notes.push({
        id: `${spec.id}-x-${mi}`,
        measure: m.measure,
        startBeat: mi * beatsPerMeasure + 1.4,
        durationBeats: 0.5,
        midi: 71 + Math.floor(rng() * 4),
        hand: "R",
        status: "extra",
        velocity: 48,
      });
    }
    // 左手：ワルツ伴奏（バス＋和音）
    for (let b = 0; b < beatsPerMeasure; b++) {
      const midi = b === 0 ? 41 + SCALE[Math.floor(rng() * 4)] : 53 + SCALE[Math.floor(rng() * 5)];
      const r = rng();
      const status: RollNote["status"] = bad && r > 0.85 ? "late" : "correct";
      notes.push({
        id: `${spec.id}-l-${mi}-${b}`,
        measure: m.measure,
        startBeat: mi * beatsPerMeasure + b,
        durationBeats: 0.8,
        midi,
        hand: "L",
        status,
        velocity: Math.round(38 + rng() * 25),
      });
    }
  });
  return notes;
}

export function buildTake(spec: TakeSpec): Take {
  const rng = makeRng(spec.seed);
  const [from, to] = spec.measureRange;
  const measureScores: MeasureScore[] = [];
  for (let m = from; m <= to; m++) {
    measureScores.push(measureScoreFor(spec, m, rng));
  }

  const metrics = {} as Record<MetricKey, number>;
  for (const key of METRIC_KEYS) {
    const avg =
      measureScores.reduce((acc, m) => acc + m.metrics[key], 0) / measureScores.length;
    metrics[key] = round(clamp(avg, 15, 100));
  }
  const overall = round(
    measureScores.reduce((acc, m) => acc + m.score, 0) / measureScores.length,
  );

  return {
    id: spec.id,
    songId: spec.songId,
    label: spec.label,
    recordedAt: spec.recordedAt,
    durationSec: spec.durationSec,
    measureRange: spec.measureRange,
    tempoBpm: spec.tempoBpm,
    overallScore: overall,
    metrics,
    measureScores,
    issues: buildIssues(spec, measureScores),
    tempoCurve: buildTempoCurve(spec, measureScores),
    dynamicsCurve: buildDynamicsCurve(spec, measureScores),
    roll: buildRoll(spec, measureScores),
    aiReview: spec.aiReview,
    memo: spec.memo,
  };
}
