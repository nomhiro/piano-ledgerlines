// M5バックエンドの「ドキュメント」型。docs/design/data-model.md のCosmosコンテナ設計と
// docs/spec/api.md のレスポンス形状に合わせる。ローカル実装ではこれをそのままJSONファイルとして
// 保存する（本番ではCosmos DBのドキュメントにマップする想定）。
//
// 5指標(pitch/rhythm/tempo/dynamics/pedal)はUIと共有するため src/lib/mock/types.ts の
// MetricKey をそのまま再利用する。articulation はPoC検証により削除済み。
import type { MetricKey } from "@/lib/mock/types";

export type SongDocStatus = "awaiting_score" | "ready";

export interface ScoreWarning {
  code: string;
  message: string;
  measures?: number[];
}

export interface SongDoc {
  id: string;
  userId: string;
  title: string;
  composer: string;
  targetTempo: number | null;
  targetDate: string | null;
  status: SongDocStatus;
  measureCount: number | null;
  scoreMeasureCount: number | null;
  keySignature: string | null;
  timeSignature: string | null;
  detectedTempo: number | null;
  hasRepeats: boolean;
  warnings: ScoreWarning[];
  lastScoreError?: string;
  scoreFileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TakeStatus =
  | "uploading"
  | "uploaded"
  | "queued"
  | "transcribing"
  | "aligning"
  | "scoring"
  | "completed"
  | "failed";

export interface TakeFailure {
  code: string;
  message: string;
}

export interface MeasureScoreDoc {
  measure: number;
  scoreMeasure: number;
  score: number | null;
  confidence: number;
  metrics: Record<MetricKey, number | null>;
  noteCount: number;
}

export interface IssueDoc {
  id: string;
  kind: string;
  severity: "high" | "medium" | "low";
  measures: number[];
  summary: string;
  metric: MetricKey;
}

export interface TakeDoc {
  id: string;
  userId: string;
  songId: string;
  label: string;
  recordedAt: string;
  durationSec: number;
  requestedMeasureRange: [number, number];
  playedMeasureRange: [number, number] | null;
  requestedTempo: number | null;
  inputKind: "audio" | "midi";
  contentType: string | null;
  status: TakeStatus;
  progress: number;
  failure: TakeFailure | null;

  overallScore: number | null;
  metrics: Record<MetricKey, number | null> | null;
  metricsNAReason: Partial<Record<MetricKey, string>>;
  measureScores: MeasureScoreDoc[];
  issues: IssueDoc[];

  aiReview: unknown | null;
  analysis: Record<string, unknown> | null;

  memo: string;
  createdAt: string;
  updatedAt: string;
}

// api.md 5.1 `POST /songs` 相当（ローカル簡略版: SASなしの直接multipartアップロード）
export interface CreateSongInput {
  title: string;
  composer: string;
  targetTempo?: number | null;
  targetDate?: string | null;
}

// api.md 5.2 `POST /songs/{songId}/takes` 相当
export interface CreateTakeInput {
  label: string;
  recordedAt: string;
  durationSec: number;
  requestedMeasureRange: [number, number];
  requestedTempo?: number | null;
  inputKind: "audio" | "midi";
  contentType: string | null;
}
