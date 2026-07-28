// 5指標構成（PoC検証によりarticulationは削除済み。docs/spec/metrics.md参照）
export type MetricKey = "pitch" | "rhythm" | "tempo" | "dynamics" | "pedal";

export const METRIC_KEYS: MetricKey[] = [
  "pitch",
  "rhythm",
  "tempo",
  "dynamics",
  "pedal",
];

export const METRIC_LABELS: Record<MetricKey, string> = {
  pitch: "音程正確性",
  rhythm: "リズム",
  tempo: "テンポ安定",
  dynamics: "ダイナミクス",
  pedal: "ペダル",
};

export const METRIC_DESCRIPTIONS: Record<MetricKey, string> = {
  pitch: "楽譜どおりの音を鳴らせているか（抜け音・余分な音）",
  rhythm: "各音の発音タイミングが譜面の音価に忠実か",
  tempo: "設定テンポに対する揺れの少なさ（意図的なルバートは除外）",
  dynamics: "強弱記号に対する音量差の再現度",
  pedal: "ペダルの踏み替えタイミングと濁りの少なさ",
};

export type SongStatus = "reading" | "practicing" | "polishing" | "ready";

export const SONG_STATUS_LABELS: Record<SongStatus, string> = {
  reading: "譜読み",
  practicing: "練習中",
  polishing: "仕上げ",
  ready: "本番準備OK",
};

export interface Song {
  id: string;
  title: string;
  composer: string;
  period: string;
  keySignature: string;
  timeSignature: string;
  difficulty: number;
  totalMeasures: number;
  scoreUrl: string | null;
  accent: string;
  status: SongStatus;
  goalDate: string | null;
  goalDescription: string | null;
  addedAt: string;
  targetTempo: number;
  currentTempo: number;
  sharedWithTeacher: boolean;
}

export interface MeasureScore {
  measure: number;
  score: number;
  metrics: Record<MetricKey, number>;
}

export type IssueType =
  | "missed-note"
  | "extra-note"
  | "timing"
  | "dynamics"
  | "pedal"
  | "tempo";

export const ISSUE_LABELS: Record<IssueType, string> = {
  "missed-note": "抜け音",
  "extra-note": "余分な音",
  timing: "タイミングずれ",
  dynamics: "強弱",
  pedal: "ペダル",
  tempo: "テンポ",
};

export type Severity = "high" | "medium" | "low";

export interface Issue {
  id: string;
  measure: number;
  beat: number;
  type: IssueType;
  severity: Severity;
  title: string;
  detail: string;
}

export type NoteStatus = "correct" | "missed" | "extra" | "late" | "early";

export interface RollNote {
  id: string;
  measure: number;
  startBeat: number;
  durationBeats: number;
  midi: number;
  hand: "L" | "R";
  status: NoteStatus;
  velocity: number;
}

export interface PracticeItem {
  id: string;
  title: string;
  measures: [number, number];
  tempoBpm: number;
  minutes: number;
  method: string;
  why: string;
}

export interface AiReview {
  headline: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  practiceMenu: PracticeItem[];
  context: string;
}

export interface Take {
  id: string;
  songId: string;
  label: string;
  recordedAt: string;
  durationSec: number;
  measureRange: [number, number];
  tempoBpm: number;
  overallScore: number;
  metrics: Record<MetricKey, number>;
  measureScores: MeasureScore[];
  issues: Issue[];
  tempoCurve: { measure: number; bpm: number; target: number }[];
  dynamicsCurve: { measure: number; actual: number; target: number }[];
  roll: RollNote[];
  aiReview: AiReview;
  memo: string;
}

export interface TeacherComment {
  id: string;
  songId: string;
  takeId: string | null;
  measure: number | null;
  author: string;
  role: "teacher" | "student";
  body: string;
  createdAt: string;
}

export interface Assignment {
  id: string;
  songId: string;
  title: string;
  detail: string;
  dueDate: string;
  status: "todo" | "doing" | "done";
}

export interface PracticeLog {
  date: string;
  minutes: number;
  takes: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
}
