import type { AiReview, IssueType, MetricKey, Song, Take } from "@/lib/mock/types";
import type { SongDoc, TakeDoc } from "@/lib/server/types";

export function sortByRecordedAt<T extends { recordedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
}

function metricsFromDoc(metrics: Record<MetricKey, number | null> | null | undefined): Record<MetricKey, number> {
  return {
    pitch: metrics?.pitch ?? 0,
    rhythm: metrics?.rhythm ?? 0,
    tempo: metrics?.tempo ?? 0,
    dynamics: metrics?.dynamics ?? 0,
    pedal: metrics?.pedal ?? 0,
  };
}

function measuresRangeFromTake(take: TakeDoc): [number, number] {
  if (take.playedMeasureRange) return take.playedMeasureRange;
  if (take.requestedMeasureRange.length === 2) return take.requestedMeasureRange;
  return [1, 1];
}

function normalizeCoachReview(value: unknown, take: TakeDoc): AiReview {
  if (!value || typeof value !== "object") {
    return {
      headline: `${take.label} の分析結果`,
      summary: "AI分析の結果がまだ反映されていません。短い範囲で録音し、改善点を確認してください。",
      strengths: ["録音データが保存されています。次回と比較できます。"],
      improvements: ["課題箇所を1小節ずつ切り出して練習してください。"],
      practiceMenu: [
        {
          id: `${take.id}-menu-1`,
          title: `${measuresRangeFromTake(take)[0]}〜${measuresRangeFromTake(take)[1]}小節を分解`,
          measures: measuresRangeFromTake(take),
          tempoBpm: take.requestedTempo ?? 60,
          minutes: 5,
          method: "短い区間だけをゆっくり録音し、音のずれとリズムを確認します。",
          why: "変化のつかみやすさを高めるためです。",
        },
      ],
      context: "分析結果は後続の比較演習で使えるように保存されています。",
    };
  }

  const review = value as { review?: unknown; metadata?: unknown; headline?: string; summary?: string; context?: string; strengths?: unknown[]; improvements?: unknown[]; practiceMenu?: unknown[] };

  if (review.review && typeof review.review === "object") {
    return normalizeCoachReview(review.review, take);
  }

  const headlines = review.headline ?? `${take.label} の分析結果`;
  const summary = review.summary ?? "AI分析結果をもとに、短い範囲で確認してください。";
  const context = review.context ?? "この楽曲の演奏を小節単位で見直して、改善点を絞って練習します。";

  const strengths = Array.isArray(review.strengths)
    ? review.strengths.map((item) => (typeof item === "string" ? item : (item as { text?: string }).text ?? "分析結果が保存されています。"))
    : ["録音データが保存されています。次回と比較できます。"];

  const improvements = Array.isArray(review.improvements)
    ? review.improvements.map((item) => (typeof item === "string" ? item : (item as { text?: string }).text ?? "課題箇所を絞って練習してください。"))
    : ["課題箇所を1小節ずつ切り出して練習してください。"];

  const practiceMenu = Array.isArray(review.practiceMenu)
    ? review.practiceMenu.map((item, index) => {
        const practice = item as {
          id?: string;
          title?: string;
          measures?: number[];
          tempoBpm?: number;
          minutes?: number;
          method?: string;
          why?: string;
        };
        const range = practice.measures && practice.measures.length >= 2
          ? [practice.measures[0], practice.measures[practice.measures.length - 1]] as [number, number]
          : measuresRangeFromTake(take);
        return {
          id: practice.id ?? `${take.id}-menu-${index}`,
          title: practice.title ?? `練習 ${index + 1}`,
          measures: range,
          tempoBpm: practice.tempoBpm ?? take.requestedTempo ?? 60,
          minutes: practice.minutes ?? 5,
          method: practice.method ?? "短い区間をゆっくり録音し、音のずれとリズムを確認します。",
          why: practice.why ?? "変化のつかみやすさを高めるためです。",
        };
      })
    : [
        {
          id: `${take.id}-menu-1`,
          title: `${measuresRangeFromTake(take)[0]}〜${measuresRangeFromTake(take)[1]}小節を分解`,
          measures: measuresRangeFromTake(take),
          tempoBpm: take.requestedTempo ?? 60,
          minutes: 5,
          method: "短い区間だけをゆっくり録音し、音のずれとリズムを確認します。",
          why: "変化のつかみやすさを高めるためです。",
        },
      ];

  return {
    headline: headlines,
    summary,
    strengths,
    improvements,
    practiceMenu,
    context,
  };
}

export function toHistorySong(song: SongDoc): Song {
  return {
    id: song.id,
    title: song.title,
    composer: song.composer,
    period: "",
    keySignature: song.keySignature ?? "不明",
    timeSignature: song.timeSignature ?? "不明",
    difficulty: 0,
    totalMeasures: song.measureCount ?? 0,
    scoreUrl: song.previewScoreFileName ? `/api/songs/${song.id}/score/file` : null,
    accent: "#8b5cf6",
    status: song.status === "ready" ? "ready" : "practicing",
    goalDate: song.targetDate,
    goalDescription: song.targetDate ? "目標に向けて練習" : null,
    addedAt: song.createdAt,
    targetTempo: song.targetTempo ?? song.detectedTempo ?? 120,
    currentTempo: song.detectedTempo ?? song.targetTempo ?? 120,
    sharedWithTeacher: false,
  };
}

export function toHistoryTake(take: TakeDoc): Take {
  const metrics = metricsFromDoc(take.metrics);
  const measureScores = take.measureScores.map((measureScore) => ({
    measure: measureScore.measure,
    score: measureScore.score ?? 0,
    metrics: {
      pitch: measureScore.metrics?.pitch ?? 0,
      rhythm: measureScore.metrics?.rhythm ?? 0,
      tempo: measureScore.metrics?.tempo ?? 0,
      dynamics: measureScore.metrics?.dynamics ?? 0,
      pedal: measureScore.metrics?.pedal ?? 0,
    },
  }));

  return {
    id: take.id,
    songId: take.songId,
    label: take.label,
    recordedAt: take.recordedAt,
    durationSec: take.durationSec,
    measureRange: take.playedMeasureRange ?? take.requestedMeasureRange,
    tempoBpm: take.requestedTempo ?? 120,
    overallScore: take.overallScore ?? 0,
    metrics,
    measureScores,
    issues: take.issues.map((issue) => ({
      id: issue.id,
      measure: issue.measures[0] ?? 0,
      beat: 1,
      type: issue.metric as IssueType,
      severity: issue.severity,
      title: issue.summary,
      detail: issue.observation ?? issue.summary,
    })),
    tempoCurve: [],
    dynamicsCurve: [],
    roll: [],
    aiReview: normalizeCoachReview(take.aiReview, take),
    memo: take.memo,
  };
}

export function getSongListWithRealSongs(realSongs: SongDoc[], fallbackSongs: Song[]): Song[] {
  return [...realSongs.map(toHistorySong), ...fallbackSongs];
}
