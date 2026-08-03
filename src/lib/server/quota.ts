import { QuotaExceededError } from "./http";
import { countTakesSince } from "./repository";

export const FREE_MONTHLY_TAKE_LIMIT = 5;

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function assertTakeQuota(
  userId: string,
  plan: "free" | "paid",
  now = new Date()
): Promise<{ used: number; limit: number | null }> {
  if (plan === "paid") return { used: 0, limit: null };
  const used = await countTakesSince(userId, monthStartIso(now));
  if (used >= FREE_MONTHLY_TAKE_LIMIT) {
    throw new QuotaExceededError(
      `free plan allows ${FREE_MONTHLY_TAKE_LIMIT} takes per month`
    );
  }
  return { used, limit: FREE_MONTHLY_TAKE_LIMIT };
}
