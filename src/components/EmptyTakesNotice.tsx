import Link from "next/link";
import { Card } from "@/components/ui";
import type { EmptyTakesGuidance } from "@/components/empty-takes";

/**
 * 録音や曲がまだ無いときの空状態。フックを持たないので Server Component から
 * そのまま描ける（`TakeEvaluationPanel` と同じ扱い）。
 *
 * 何を勧めるかの判定は `empty-takes.ts` が持つ。ここは表示だけを担う。
 */
export default function EmptyTakesNotice({ guidance }: { guidance: EmptyTakesGuidance }) {
  return (
    <Card className="mt-5">
      <div className="flex flex-col items-center gap-4 px-5 py-10 text-center">
        <p className="text-sm text-[var(--muted)]">{guidance.message}</p>
        <Link
          href={guidance.actionHref}
          className="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
        >
          {guidance.actionLabel}
        </Link>
      </div>
    </Card>
  );
}
