import type { TakeStatus } from "./types";

const transitions: Record<TakeStatus, readonly TakeStatus[]> = {
  uploading: ["uploaded", "failed"],
  uploaded: ["queued", "failed"],
  queued: ["transcribing", "failed"],
  transcribing: ["aligning", "failed"],
  aligning: ["scoring", "failed"],
  scoring: ["reviewing", "completed", "failed"],
  reviewing: ["completed", "failed"],
  completed: [],
  failed: ["queued"],
};

export function assertTakeTransition(current: TakeStatus, next: TakeStatus): void {
  if (current === next) return;
  if (!transitions[current].includes(next)) {
    throw new Error(`invalid take status transition: ${current} -> ${next}`);
  }
}
