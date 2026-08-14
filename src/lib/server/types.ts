// M5バックエンドの「ドキュメント」型。docs/design/data-model.md のCosmosコンテナ設計と
// docs/spec/api.md のレスポンス形状に合わせる。ローカル実装ではこれをそのままJSONファイルとして
// 保存する（本番ではCosmos DBのドキュメントにマップする想定）。
//
// 5指標(pitch/rhythm/tempo/dynamics/pedal)はUIと共有するため src/lib/mock/types.ts の
// MetricKey をそのまま再利用する。articulation はPoC検証により削除済み。
import type { MetricKey } from "@/lib/mock/types";

export type SongDocStatus = "awaiting_score" | "converting_score" | "reviewing_score" | "omr_failed" | "ready";

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
  sourceScoreFileName: string | null;
  scoreSource: "musicxml" | "midi" | "pdf" | null;
  omrEngine: "audiveris" | null;
  omrError?: string;
  previewScoreFileName: string | null;
  previewMidiFileName: string | null;
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
  | "reviewing"
  | "completed"
  | "failed";

export interface TakeFailure {
  code: string;
  message: string;
}

export type EvaluationStatus = "scored" | "reference" | "withheld" | "unavailable";

export interface MetricEvaluationDoc {
  status: EvaluationStatus;
  confidence: number | null;
  reasonCode: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export interface TakeEvaluationDoc {
  status: "scored" | "withheld";
  confidence: number | null;
  reasonCode: string | null;
  reason: string | null;
  calibrationVersion: string | null;
}

export interface MeasureScoreDoc {
  measure: number;
  scoreMeasure: number;
  score: number | null;
  confidence: number | null;
  metrics: Record<MetricKey, number | null>;
  metricEvaluations: Record<MetricKey, MetricEvaluationDoc>;
  noteCount: number;
}

export interface IssueDoc {
  id: string;
  kind: string;
  severity: "high" | "medium" | "low";
  measures: number[];
  summary: string;
  metric: MetricKey;
  confidence: number | null;
  observation: string;
  evidence: Record<string, unknown>;
  practiceAction: string;
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
  metricConfidence: Record<MetricKey, number | null>;
  metricEvaluations: Partial<Record<MetricKey, MetricEvaluationDoc>>;
  metricsNAReason: Partial<Record<MetricKey, string>>;
  evaluation: TakeEvaluationDoc | null;
  measureScores: MeasureScoreDoc[];
  issues: IssueDoc[];

  aiReview: unknown | null;
  analysis: Record<string, unknown> | null;

  memo: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSettings {
  dailyPracticeMinutes: number;
  locale: string;
  allowTrainingUse: boolean;
  notifyOnAnalysisComplete: boolean;
}

export interface ClassroomReference {
  classroomId: string;
  role: ClassroomRole;
  status: ClassroomMemberStatus;
  generation?: number;
  operationVersion?: string | null;
}

export interface UserProfileDoc {
  id: string;
  type: "user";
  email: string;
  normalizedEmail: string;
  displayName: string;
  provider: "google" | "entra" | "development";
  providerSyncedAt: string;
  settings: UserSettings;
  classroomRefs: ClassroomReference[];
  createdAt: string;
  updatedAt: string;
}

export type ClassroomRole = "owner" | "teacher" | "student";
export type ClassroomMemberStatus = "provisioning" | "active" | "removing" | "removed";
export type ClassroomAppStatus = "provisioning" | "active" | "suspended" | "archived";
export type ClassroomContractStatus =
  | "none"
  | "incomplete"
  | "active"
  | "past_due"
  | "canceled";

export interface ClassroomDoc {
  id: string;
  type: "classroom";
  name: string;
  ownerUserId: string;
  teacherLimit: number;
  /** Includes active/provisioning teachers and pending teacher invitations. */
  reservedTeacherSeatCount?: number;
  teacherSeatVersion?: number;
  invitationRateLimits?: Record<string, {
    windowStartedAt: string;
    count: number;
  }>;
  /** @deprecated Legacy documents are migrated and this field is deleted by reconciliation. */
  pendingInvitationKeys?: Record<string, string>;
  invitationReservations?: Record<string, ClassroomInvitationReservationDoc>;
  billableStudentCount: number;
  billing: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    status: ClassroomContractStatus;
    stripeStatus?: string | null;
    stripeBaseSubscriptionItemId?: string | null;
    stripeStudentSubscriptionItemId?: string | null;
    stripeCurrentPeriodStart?: string | null;
    stripeCurrentPeriodEnd?: string | null;
    stripeSubscriptionCreatedAt?: number | null;
    stripeSubscriptionSelectionKey?: string | null;
    stripeSubscriptionSelectionVersion?: number;
    billingVersion?: number;
    checkoutAttempt?: CheckoutAttemptDoc | null;
    portalAttempt?: PortalAttemptDoc | null;
    studentQuantityOperation?: BillingOperationLeaseDoc | null;
  };
  appStatus: ClassroomAppStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomInvitationReservationDoc {
  invitationId: string;
  role: Exclude<ClassroomRole, "owner">;
  emailRoleFingerprint: string;
  state: "creating" | "committing" | "linked" | "pending" | "accepting" | "sending" | "resending";
  ownerToken: string;
  version: string;
  generation: number;
  deliveryOwnerToken?: string | null;
  deliveryLeaseExpiresAt?: string | null;
  deliverySourceGeneration?: number | null;
  deliverySourceVersion?: string | null;
  createdAt: string;
  leaseExpiresAt: string;
}

export interface CheckoutAttemptDoc {
  operationKeyHash: string;
  attemptId: string;
  sessionId: string | null;
  sessionUrl: string | null;
  status: "pending" | "completed" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface PortalAttemptDoc {
  operationKeyHash: string;
  attemptId: string;
  sessionId: string | null;
  sessionUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface BillingOperationLeaseDoc {
  operationVersion: string;
  ownerToken: string;
  targetQuantity: number;
  status: "pending" | "pending_reconciliation" | "completed" | "failed" | "blocked_inactive";
  startedAt: string;
  expiresAt: string;
  completedAt?: string | null;
  lastError?: string | null;
}

export interface ClassroomMemberDoc {
  id: string;
  type: "classroom-member";
  classroomId: string;
  userId: string;
  role: ClassroomRole;
  status: ClassroomMemberStatus;
  operationVersion?: string | null;
  billingDesiredStatus?: "active" | "removed" | null;
  generation?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomInvitationDoc {
  id: string;
  type: "classroom-invitation";
  classroomId: string;
  email: string;
  normalizedEmail: string;
  role: Exclude<ClassroomRole, "owner">;
  status: "preparing" | "pending" | "accepting" | "accepted" | "expired" | "revoked";
  tokenHash: string | null;
  tokenVersion?: number;
  generation?: number;
  reservationVersion?: string | null;
  reservationOwnerToken?: string | null;
  expiresAt: string | null;
  createdByUserId: string;
  acceptedByUserId?: string | null;
  acceptOperationVersion?: string | null;
  claimedByUserId?: string | null;
  claimedTokenFingerprint?: string | null;
  claimedAt?: string | null;
  sentAt?: string | null;
  resentAt?: string | null;
  deliveryStatus?: "pending" | "sent" | "failed";
  deliveryError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingEventDoc {
  id: string;
  type: "billing-event";
  provider: "stripe";
  eventType: string;
  livemode: boolean;
  payloadHash: string;
  processedAt: string | null;
  createdAt: string;
  status?: "processing" | "processed" | "failed";
  attemptCount?: number;
  lastError?: string | null;
  stripeCreatedAt?: number;
  processingOwnerToken?: string | null;
  processingStartedAt?: string | null;
  processingExpiresAt?: string | null;
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
