// ローカル開発用のデータレイアウト。worker/worker_main.py が読み書きするパスと
// 1対1で一致させる必要がある（Node側とPythonワーカー側でファイルレイアウトの
// 契約を共有しているため、変更する場合は両方を更新すること）。
//
// 本番フェーズでは、この関数群を Azure Blob Storage / Cosmos DB を叩く実装に
// 差し替える（呼び出し側のAPIルートは変更不要になるよう抽象化している）。
import path from "node:path";

// リポジトリルート（このファイルから見て ../../../ = nomhiro-scaling-guide/）。
// `next dev` はワークスペースルートを cwd として起動される前提。
export const REPO_ROOT = process.cwd();

export const DATA_DIR = process.env.LEDGERLINES_DATA_DIR
  ? path.resolve(process.env.LEDGERLINES_DATA_DIR)
  : path.join(REPO_ROOT, ".data");

export const WORKER_DIR = path.join(REPO_ROOT, "worker");
export const WORKER_MAIN = path.join(WORKER_DIR, "worker_main.py");

function fileSegment(value: string): string {
  return encodeURIComponent(value);
}

export function songDocPath(songId: string): string {
  return path.join(DATA_DIR, "songs", `${fileSegment(songId)}.json`);
}

export function songsDir(): string {
  return path.join(DATA_DIR, "songs");
}

export function scoreFilePath(songId: string, fileName: string): string {
  return path.join(DATA_DIR, "scores", fileSegment(songId), fileName);
}

export function referenceJsonPath(songId: string): string {
  return path.join(DATA_DIR, "derived", songId, "reference.json");
}

export function takeDocPath(takeId: string): string {
  return path.join(DATA_DIR, "takes", `${fileSegment(takeId)}.json`);
}

export function takesDir(): string {
  return path.join(DATA_DIR, "takes");
}

export function userDocPath(userId: string): string {
  return path.join(DATA_DIR, "users", `${fileSegment(userId)}.json`);
}

export function usersDir(): string {
  return path.join(DATA_DIR, "users");
}

export function classroomDocPath(classroomId: string): string {
  return path.join(DATA_DIR, "classrooms", `${fileSegment(classroomId)}.json`);
}

export function classroomsDir(): string {
  return path.join(DATA_DIR, "classrooms");
}

export function classroomMemberDocPath(classroomId: string, memberId: string): string {
  return path.join(DATA_DIR, "classroom-members", fileSegment(classroomId), `${fileSegment(memberId)}.json`);
}

export function classroomMembersDir(classroomId?: string): string {
  return classroomId
    ? path.join(DATA_DIR, "classroom-members", fileSegment(classroomId))
    : path.join(DATA_DIR, "classroom-members");
}

export function classroomInvitationDocPath(classroomId: string, invitationId: string): string {
  return path.join(
    DATA_DIR,
    "classroom-invitations",
    fileSegment(classroomId),
    `${fileSegment(invitationId)}.json`,
  );
}

export function classroomInvitationsDir(classroomId?: string): string {
  return classroomId
    ? path.join(DATA_DIR, "classroom-invitations", fileSegment(classroomId))
    : path.join(DATA_DIR, "classroom-invitations");
}

export function billingEventDocPath(eventId: string): string {
  return path.join(DATA_DIR, "billing-events", `${fileSegment(eventId)}.json`);
}

export function billingEventsDir(): string {
  return path.join(DATA_DIR, "billing-events");
}

export function audioDir(takeId: string): string {
  return path.join(DATA_DIR, "audio", fileSegment(takeId));
}

export function audioFilePath(takeId: string, fileName: string): string {
  return path.join(audioDir(takeId), fileName);
}
