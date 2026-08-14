import { createHash, randomUUID } from "node:crypto";

// api.md の例では `song_01J8...`（ULID風）を使っているが、ローカル実装では
// 衝突回避が容易な randomUUID ベースの短縮IDで代用する。
function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function newSongId(): string {
  return `song_${shortId()}`;
}

export function newTakeId(): string {
  return `take_${shortId()}`;
}

export function classroomMemberId(classroomId: string, userId: string): string {
  return `member_${createHash("sha256").update(`${classroomId}:${userId}`).digest("hex").slice(0, 32)}`;
}

export function newIssueId(index: number): string {
  return `iss_${index}`;
}
