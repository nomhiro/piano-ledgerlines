# 演奏スコアの復帰 実装計画（段1・段2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留（null）を 0 点として描画するバグを解消し、M4 で頑健性を実測済みの
`tempo` / `rhythm` / `dynamics` / `pedal` の採点を復帰させる。

**Architecture:** ワーカー側は `confidence.py` の無条件保留を指標別ポリシーに置き換え、
`preprocess.py` の録音品質指標で `dynamics`（AGC）と `rhythm`（デッドゾーン）を制御し、
`reference.py` にペダルイベントを出力させて参照ペダル区間を配線する。UI 側はモック用
コンポーネントへ実データを流す経路（`toHistoryTake`）を廃止し、`/takes/real/[takeId]` が
既に持っている正直な表示ロジックを共有コンポーネントに抽出して再利用する。

**Tech Stack:** Next.js App Router（React Server Components）、TypeScript、
Node.js 組み込みテストランナー（`tsx --test`）、Python 3 + `unittest`、numpy、
pretty_midi、music21、soundfile。

**Spec:** `docs/superpowers/specs/2026-08-15-restore-performance-scores-design.md`

## Global Constraints

- **段3（pitch の extra 分類と τ 再校正）は本計画に含まない。** MAESTRO データ取得が前提の
  ため別計画とする。本計画の完了時点で pitch は `withheld`（理由コード
  `PITCH_FORMULA_UNVALIDATED`）、`overallScore` は `null` のままである。
- **`overallScore` は本計画では数値にならない。** spec 5.4 の規則により、`withheld` な指標が
  1つでも残る場合は `null`。pitch の重みは 0.28 で最大のため、除外した加重平均を「総合点」
  として提示しない。「0点」表示の解消が本計画の到達点である。
- **モック UI（`src/lib/mock/`）は変更しない。** `src/lib/mock/types.ts` の
  `Take` / `MeasureScore` は `Record<MetricKey, number>`（非 nullable）であり、実データの
  `unavailable` を表現できない。実データはモック用コンポーネントに流さない。
- **AGC 検出は `dynamicRangeDb < 10`、劣化録音判定は `dynamicRangeDb < 14`。** 用途の異なる
  2つの閾値であり、統一してはならない（`m4-report.md` 5.1 / `metrics.md:860`）。
- `AGENTS.md` の指示: `src/app/**` の App Router コードを書く前に
  `node_modules/next/dist/docs/` の該当ガイドを読むこと。この版の Next.js は訓練データと
  API・規約が異なる。
- ワーカーのテストは各ファイルを直接実行する（`worker/` を cwd として
  `python tests/test_x.py`）。各テストファイルが自身で `sys.path` を設定している。
- `src/lib/server/` のローカル JSON 状態に触る TS テストは
  `npx tsx --test --test-concurrency=1` で実行する。

---

## 段1 — UI が保留を保留として表示する

MAESTRO 不要。スコアの値は一切変えず、null の描画だけを直す。

### Task 1: CoachView をスコア非依存にする

`/coach` の `CoachView` は `take.aiReview` / `take.recordedAt` / `take.label` のみを参照し、
スコアを一切描画しない（`src/components/CoachView.tsx:54,77,79,88,91,96,164,204`）。にも
かかわらず `Take` 全体を要求するため、実データを渡すには `toHistoryTake` でスコアを
捏造する必要があった。プロップを実際に使う範囲へ絞る。

**Files:**
- Modify: `src/components/CoachView.tsx:22-33`（プロップ型）
- Modify: `src/lib/real-history.ts`（`toCoachTake` を追加）
- Modify: `src/app/coach/page.tsx:11,30`
- Test: `src/lib/real-history.test.ts`

**Interfaces:**
- Produces: `CoachTake`（`src/components/CoachView.tsx` から export）=
  `Pick<Take, "id" | "label" | "recordedAt" | "aiReview">`
- Produces: `toCoachTake(take: TakeDoc): CoachTake`（`src/lib/real-history.ts` から export）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/real-history.test.ts` に追記する。

```ts
import { sortByRecordedAt, toCoachTake } from "./real-history";
import type { TakeDoc } from "@/lib/server/types";

function takeDocFixture(overrides: Partial<TakeDoc> = {}): TakeDoc {
  return {
    id: "take_abc",
    userId: "usr_local_dev",
    songId: "song_abc",
    label: "テイク1",
    recordedAt: "2026-08-14T21:00:00+09:00",
    durationSec: 92,
    requestedMeasureRange: [1, 8],
    playedMeasureRange: null,
    requestedTempo: 96,
    inputKind: "audio",
    contentType: "audio/webm",
    status: "completed",
    progress: 1,
    failure: null,
    overallScore: null,
    metrics: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
    metricConfidence: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
    metricEvaluations: {},
    metricsNAReason: {},
    evaluation: null,
    measureScores: [],
    issues: [],
    aiReview: null,
    analysis: null,
    memo: "",
    createdAt: "2026-08-14T21:00:00+09:00",
    updatedAt: "2026-08-14T21:05:00+09:00",
    ...overrides,
  };
}

test("toCoachTake exposes only fields CoachView reads", () => {
  const result = toCoachTake(takeDocFixture());

  assert.deepStrictEqual(Object.keys(result).sort(), [
    "aiReview",
    "id",
    "label",
    "recordedAt",
  ]);
  assert.strictEqual(result.id, "take_abc");
  assert.strictEqual(result.label, "テイク1");
});

test("toCoachTake never fabricates a score field", () => {
  const result = toCoachTake(takeDocFixture()) as Record<string, unknown>;

  assert.strictEqual("overallScore" in result, false);
  assert.strictEqual("metrics" in result, false);
  assert.strictEqual("measureScores" in result, false);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx tsx --test src/lib/real-history.test.ts`
Expected: FAIL — `toCoachTake` が export されていない

- [ ] **Step 3: `CoachTake` 型を定義する**

`src/components/CoachView.tsx` の import 行の直後に追加し、プロップ型を差し替える。

```tsx
export type CoachTake = Pick<Take, "id" | "label" | "recordedAt" | "aiReview">;
```

`src/components/CoachView.tsx:22-33` を次のように変更する。

```tsx
export default function CoachView({
  songs,
  song,
  take,
  seed,
  stagnant,
}: {
  songs: Song[];
  song: Song;
  take: CoachTake;
  seed: ChatMessage[];
  stagnant: { measure: number; delta: number; score: number }[];
}) {
```

- [ ] **Step 4: `toCoachTake` を実装する**

`src/lib/real-history.ts` に追加する。`normalizeCoachReview` は既存の private 関数を使う。

```ts
import type { CoachTake } from "@/components/CoachView";

export function toCoachTake(take: TakeDoc): CoachTake {
  return {
    id: take.id,
    label: take.label,
    recordedAt: take.recordedAt,
    aiReview: normalizeCoachReview(take.aiReview, take),
  };
}
```

- [ ] **Step 5: `/coach` を `toCoachTake` に切り替える**

`src/app/coach/page.tsx:11` の import を変更する。

```tsx
import { toHistorySong, toCoachTake } from "@/lib/real-history";
```

同ファイル `:30` を変更する。

```tsx
    const takes = realSong ? (await listTakesBySong(selectedId)).map(toCoachTake) : [];
```

- [ ] **Step 6: テストを実行して通過を確認する**

Run: `npx tsx --test src/lib/real-history.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 7: 型チェックする**

Run: `npm install && npx tsc --noEmit`
Expected: エラーなし。モック側の `/coach` は完全な `Take` を渡すが、`CoachTake` を
構造的に満たすため変更不要である。

- [ ] **Step 8: コミットする**

```bash
git add src/components/CoachView.tsx src/lib/real-history.ts src/app/coach/page.tsx src/lib/real-history.test.ts
git commit -m "refactor: narrow CoachView props to score-independent fields"
```

---

### Task 2: 評価表示コンポーネントを抽出する

`/takes/real/[takeId]/page.tsx` は保留・算出不可・参考値を正しく描画できている唯一の画面
（`:71-131` が総合スコアと5指標、`:161-188` が小節ヒートマップ）。これを共有コンポーネント
に抽出し、`/progress` と `/share` から再利用できるようにする。

props は `TakeDoc`（サーバーコンポーネント側）と `ApiTakeDetail`（クライアント側）の両方が
構造的に満たす形にする。`ApiTakeDetail` は `recordedAt` を持たず、`Record<string, ...>` を
使う点に注意する。

**Files:**
- Create: `src/components/TakeEvaluationPanel.tsx`
- Create: `src/components/TakeEvaluationPanel.test.tsx` は作らない（描画テストの基盤が
  リポジトリに無いため、検証は Task 3 の型チェックと目視で行う）
- Modify: `src/app/takes/real/[takeId]/page.tsx:11-22,69-188`

**Interfaces:**
- Produces: `TakeEvaluationPanel`（default export）と
  `TakeEvaluationData`（named export）を `src/components/TakeEvaluationPanel.tsx` から
- Consumes: `Card`, `CardTitle`, `ScoreRing`, `MetricBar`, `Badge`（`@/components/ui`）、
  `METRIC_LABELS`, `MetricKey`（`@/lib/mock/types`）

- [ ] **Step 1: Next.js の該当ドキュメントを読む**

`AGENTS.md` の指示に従い、Server Component から Client Component へ props を渡す規約を
確認する。

Run: `ls node_modules/next/dist/docs/`
続けて、一覧に出たガイドのうち Server / Client Components と Route Handlers に関する
ファイルを読む。抽出するコンポーネントはフックを使わないため Server Component として
書けるが、`/takes/real/[takeId]/page.tsx` は `"use client"` であり、そこからも呼ばれる。
Server Component は Client Component から呼べないため、**このコンポーネントは
`"use client"` を付けない純粋な表示コンポーネントとし、両方から使える形にする**
（フック・イベントハンドラを持たせない）。この制約が現行版で正しいかをドキュメントで
確認する。

- [ ] **Step 2: コンポーネントを作成する**

`src/components/TakeEvaluationPanel.tsx`

```tsx
import { AlertTriangle } from "lucide-react";
import { Badge, Card, CardTitle, MetricBar, ScoreRing } from "@/components/ui";
import { METRIC_LABELS, type MetricKey } from "@/lib/mock/types";

const SEVERITY_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#64748b",
};

const STATUS_LABEL: Record<string, string> = {
  scored: "採点済み",
  reference: "参考値",
  withheld: "判定保留",
  unavailable: "測定対象外",
};

export interface TakeEvaluationData {
  id: string;
  label: string;
  status: string;
  failure: { message: string } | null;
  overallScore: number | null;
  metrics: Record<string, number | null> | null;
  // `TakeDoc` 側は Partial<Record<MetricKey, ...>>、`ApiTakeDetail` 側は
  // Record<string, ...>。両方を受けるため Partial で緩める（値が undefined になり得る）。
  metricEvaluations: Partial<Record<string, { status: string; confidence: number | null; reason: string | null }>>;
  metricsNAReason: Partial<Record<string, string>>;
  evaluation: { status: string; reason: string | null } | null;
  measureScores: { measure: number; score: number | null }[];
  issues: {
    id: string;
    severity: "high" | "medium" | "low";
    measures: number[];
    summary: string;
    metric: string;
    observation?: string;
    practiceAction?: string;
  }[];
}

export default function TakeEvaluationPanel({ take }: { take: TakeEvaluationData }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="flex flex-col items-center justify-center gap-3 p-8 lg:col-span-1">
          {take.overallScore !== null ? (
            <ScoreRing score={take.overallScore} label="総合スコア" size={140} />
          ) : take.evaluation?.status === "withheld" ? (
            <div className="space-y-2 text-center">
              <div className="text-lg font-semibold text-amber-300">判定保留</div>
              <p className="max-w-xs text-xs leading-relaxed text-[var(--muted)]">
                {take.evaluation.reason}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[var(--muted)]">総合スコア未算出</p>
          )}
          {take.failure && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {take.failure.message}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle title="5指標" />
          <div className="space-y-4 p-5">
            {take.metrics &&
              (Object.keys(METRIC_LABELS) as MetricKey[]).map((key) => {
                const value = take.metrics?.[key];
                const evaluation = take.metricEvaluations?.[key];
                if (value === null || value === undefined) {
                  return (
                    <div key={key} className="flex items-start justify-between gap-4 text-xs">
                      <span className="text-[var(--muted)]">{METRIC_LABELS[key]}</span>
                      <span className="max-w-md text-right text-[var(--muted)]">
                        {STATUS_LABEL[evaluation?.status ?? ""] ?? "算出不可"}
                        {(evaluation?.reason ?? take.metricsNAReason[key])
                          ? `（${evaluation?.reason ?? take.metricsNAReason[key]}）`
                          : ""}
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={key}>
                    <MetricBar label={METRIC_LABELS[key]} value={value} />
                    {evaluation?.status === "reference" && (
                      <p className="mt-1 text-right text-[11px] text-amber-300">
                        参考値
                        {evaluation.confidence !== null
                          ? ` ・ 対応品質 ${Math.round(evaluation.confidence * 100)}%`
                          : ""}
                        {evaluation.reason ? ` — ${evaluation.reason}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            {!take.metrics && (
              <p className="text-sm text-[var(--muted)]">まだ指標がありません（解析中または未完了）。</p>
            )}
          </div>
        </Card>
      </div>

      {take.issues.length > 0 && (
        <Card>
          <CardTitle title="指摘事項" />
          <div className="space-y-2 p-5">
            {take.issues.map((issue) => (
              <div
                key={issue.id}
                className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs"
              >
                <Badge color={SEVERITY_COLOR[issue.severity] ?? "#64748b"}>{issue.severity}</Badge>
                <div>
                  <div>{issue.summary}</div>
                  <div className="mt-1 text-[var(--muted)]">
                    小節 {issue.measures.join(", ")} ・{" "}
                    {METRIC_LABELS[issue.metric as MetricKey] ?? issue.metric}
                  </div>
                  {issue.observation && (
                    <div className="mt-2 text-[var(--muted)]">根拠: {issue.observation}</div>
                  )}
                  {issue.practiceAction && (
                    <div className="mt-1 text-violet-200">練習: {issue.practiceAction}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {take.measureScores.length > 0 && (
        <Card>
          <CardTitle title="小節ごとのスコア" />
          <div className="flex flex-wrap gap-1.5 p-5">
            {take.measureScores.map((m) => (
              <div
                key={m.measure}
                title={
                  m.score === null
                    ? `小節 ${m.measure}: 判定保留`
                    : `小節 ${m.measure}: ${m.score}`
                }
                className="flex h-8 w-8 items-center justify-center rounded text-[10px] tabular-nums"
                style={{
                  backgroundColor:
                    m.score === null
                      ? "#2a3145"
                      : m.score >= 80
                        ? "#16653450"
                        : m.score >= 60
                          ? "#a1650150"
                          : "#7f1d1d50",
                  backgroundImage:
                    m.score === null
                      ? "repeating-linear-gradient(135deg, transparent, transparent 3px, #475569 3px, #475569 4px)"
                      : undefined,
                }}
              >
                {m.measure}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `/takes/real/[takeId]/page.tsx` を差し替える**

`:11-22` の `SEVERITY_COLOR` と `STATUS_LABEL` の定義を削除し（コンポーネントへ移動済み）、
`:69-188` の3つの `<Card>` ブロックを `<TakeEvaluationPanel take={take} />` に置き換える。
import を次のように整える。

```tsx
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getTake, type ApiTakeDetail } from "@/lib/api/client";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
```

`return` 本体は次の形になる。

```tsx
  return (
    <div>
      <PageHeader
        title="分析結果（実データ）"
        description={`テイク ${take.id} ・ 曲 ${take.songId} ・ ステータス: ${take.status}`}
      />

      <TakeEvaluationPanel take={take} />

      <div className="mt-5">
        <Link href="/songs/new" className="text-xs text-violet-300 underline underline-offset-2">
          別の曲を登録する
        </Link>
      </div>
    </div>
  );
```

- [ ] **Step 4: 型チェックする**

Run: `npx tsc --noEmit`
Expected: エラーなし。`ApiTakeDetail` が `TakeEvaluationData` を構造的に満たすことを
確認する。満たさない場合は `TakeEvaluationData` 側を緩める（`ApiTakeDetail` は変更しない）。

- [ ] **Step 5: lint する**

Run: `npm run lint`
Expected: エラーなし

- [ ] **Step 6: コミットする**

```bash
git add src/components/TakeEvaluationPanel.tsx "src/app/takes/real/[takeId]/page.tsx"
git commit -m "refactor: extract TakeEvaluationPanel from real take page"
```

---

### Task 3: `/progress` と `/share` の 0 点表示を撤去する

`toHistoryTake` の `?? 0`（`src/lib/real-history.ts:10-14,136-143,154`）が保留を 0 点に
潰し、`ProgressView`（`:88,135,143,146,151,280,320`）と `ShareView`（`:321`）が 0 点として
描画している。`ProgressView` / `ShareView` はモック用に設計されており
`Record<MetricKey, number>` を要求するため `unavailable` を表現できない。実データを流す
経路そのものを廃止し、Task 2 の `TakeEvaluationPanel` に置き換える。

Task 1 で `/coach` が `toCoachTake` に移ったため、この Task の完了時点で
`toHistoryTake` は参照ゼロになる。削除する。

**注意:** 実データの `/progress` はスコア推移グラフとテイク比較を失う。これらは全指標が
数値であることを前提にしており、本計画完了時点でも `overallScore` は null のため描画
できない。段3 完了後に実データ対応のチャートとして再導入する。

**spec 4.8 のうち、この Task で対応不要と確認済みの項目:**

- 「前回比の差分は両テイクの `overallScore` がともに数値のときだけ出す」— 実データの
  差分表示はこの Task で撤去されるため、対応箇所が無くなる
- 「`/coach` はスコアが出ない場合に AI 講評を要求しない」— `/api/takes/[takeId]/coach` を
  呼ぶコードは UI に存在しない（`grep -rn "takes/.*coach" src/` が API ルート自身のみに
  ヒットする）。`CoachView` は固定応答を返すモックである。ルート側の 400 応答は
  ユーザーに露出しないため変更不要
- `SongDetailView`（`src/app/songs/[id]/page.tsx:116`）と `TakeAnalysisView`
  （`src/app/takes/[id]/page.tsx:26`）はモックデータ専用の経路にのみ現れる。
  `/songs/[id]` の実データ分岐は `:86-88` で `overallScore !== null` を判定しており
  既に正しい。spec 7章の影響ファイル一覧はこの2つを過大に含めている

**Files:**
- Modify: `src/app/progress/page.tsx:6,22-36`
- Modify: `src/app/share/page.tsx:4,34-56`
- Modify: `src/lib/real-history.ts`（`metricsFromDoc` と `toHistoryTake` を削除）
- Test: `src/lib/real-history.test.ts`

**Interfaces:**
- Consumes: `TakeEvaluationPanel`, `TakeEvaluationData`（Task 2）
- Consumes: `toCoachTake`（Task 1）
- Removes: `toHistoryTake`, `metricsFromDoc`

- [ ] **Step 1: `toHistoryTake` が消えることを保証する失敗テストを書く**

`src/lib/real-history.test.ts` に追記する。

```ts
test("real-history no longer exposes a score-fabricating adapter", async () => {
  const mod: Record<string, unknown> = await import("./real-history");

  assert.strictEqual("toHistoryTake" in mod, false);
  assert.strictEqual("metricsFromDoc" in mod, false);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx tsx --test src/lib/real-history.test.ts`
Expected: FAIL — `toHistoryTake` がまだ export されている

- [ ] **Step 3: Next.js の Server Component ドキュメントを確認する**

`AGENTS.md` の指示に従い、`node_modules/next/dist/docs/` の Server Components /
`searchParams` / `notFound()` の項を読む。`/progress` と `/share` は
`searchParams: Promise<...>` を await する現行の書き方を維持する。

- [ ] **Step 4: `/progress` の実データ分岐を差し替える**

`src/app/progress/page.tsx:6` の import を変更する。

```tsx
import { toHistorySong } from "@/lib/real-history";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import { PageHeader } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
```

`:22-36` の実データ分岐を次に置き換える。

```tsx
  const realSong = selectedId.startsWith("song_") ? await getRealSong(selectedId) : null;
  if (realSong) {
    const takes = await listTakesBySong(selectedId);
    if (takes.length === 0) notFound();

    const ordered = [...takes].sort(
      (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    );

    return (
      <div>
        <PageHeader
          title={`推移 — ${realSong.title}`}
          description="スコアが算出されたテイクから推移を表示します。判定保留のテイクは理由を表示します。"
        />
        <SongSelector songs={selectableSongs} current={selectedId} />
        <div className="mt-5 space-y-6">
          {ordered.map((take) => (
            <section key={take.id}>
              <h2 className="mb-2 text-sm font-semibold">
                {take.label} ・ {new Date(take.recordedAt).toLocaleString("ja-JP")}
              </h2>
              <TakeEvaluationPanel take={take} />
            </section>
          ))}
        </div>
      </div>
    );
  }
```

`SongSelector` のプロップは `{ songs: Song[]; current: string }`
（`src/components/SongSelector.tsx:6-12`）。`pathname` と `?song=` クエリは
コンポーネント内部で処理されるので、遷移先の指定は不要である。

- [ ] **Step 5: `/share` の実データ分岐を差し替える**

`src/app/share/page.tsx:4` の import から `toHistoryTake` を除き、
`TakeEvaluationPanel` を追加する。`:34-56` の実データ分岐を次に置き換える。

```tsx
  if (selectedId.startsWith("song_")) {
    const realSong = await getRealSong(selectedId);
    const takes = realSong ? await listTakesBySong(selectedId) : [];
    if (!realSong || takes.length === 0) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-bold">共有できません</h1>
          <p className="text-sm text-[var(--muted)]">曲または録音が見つかりません。</p>
        </div>
      );
    }

    const latest = [...takes].sort(
      (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    )[0];

    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{realSong.title} の共有</h1>
        <p className="text-sm text-[var(--muted)]">
          {account?.activeClassroom
            ? `共有先: ${account.activeClassroom.name}`
            : "共有先未設定（個人利用）"}
        </p>
        <TakeEvaluationPanel take={latest} />
      </div>
    );
  }
```

- [ ] **Step 6: `metricsFromDoc` と `toHistoryTake` を削除する**

`src/lib/real-history.ts` から `metricsFromDoc`（`:8-16`）と `toHistoryTake`
（`:132-172`）を削除する。`normalizeCoachReview`、`measuresRangeFromTake`、
`sortByRecordedAt`、`toHistorySong`、`getSongListWithRealSongs`、`toCoachTake` は残す。

`IssueType` / `Take` / `MetricKey` の import が未使用になるので整理する。
`sortByRecordedAt` は `ProgressView.tsx:13` が引き続き import しているため削除しない。

- [ ] **Step 7: テストを実行して通過を確認する**

Run: `npx tsx --test src/lib/real-history.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 8: 型チェックと lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: エラーなし

- [ ] **Step 9: リポジトリ全体に `?? 0` が残っていないか確認する**

Run: `npx tsx --test src/lib/real-history.test.ts && grep -rn "overallScore ?? 0\|score ?? 0" src/`
Expected: `src/lib/mock/` 以外にヒットがない。`src/app/page.tsx:175` と
`src/app/songs/page.tsx:160` はモックデータのみを扱う箇所なので対象外
（`src/app/page.tsx:1-20` が `@/lib/mock/data` からのみ import していることを確認する）。

- [ ] **Step 10: コミットする**

```bash
git add src/app/progress/page.tsx src/app/share/page.tsx src/lib/real-history.ts src/lib/real-history.test.ts
git commit -m "fix: stop rendering withheld scores as zero on progress and share"
```

---

## 段2 — 指標別に採点を戻す

MAESTRO 不要。M4 が既に測った頑健性を実装に反映する。

### Task 4: ワーカーの Python 依存を整備する

`worker/tests/test_metrics.py` は `pretty_midi` が無く、`test_reference.py` は `music21` が
無いため現状 FAIL する。段2 で追加するテストは numpy / soundfile / pretty_midi / music21 を
必要とするため、先に環境を整えて既存テストを緑にする。

**Files:**
- 変更なし（環境整備のみ）

- [ ] **Step 1: 現状を記録する**

```bash
cd worker
for f in test_calibration test_confidence test_metrics test_reference test_teacher_metrics; do
  echo "--- $f ---"; python tests/$f.py 2>&1 | tail -3
done
```

Expected: `test_metrics` が `ModuleNotFoundError: No module named 'pretty_midi'`、
`test_reference` が FAILED（`music21` 不在）。他は OK。

- [ ] **Step 2: 依存をインストールする**

解析モデル本体（`torch`、`piano-transcription-inference`）は段2 では不要なので入れない。

```bash
python -m pip install numpy==2.2.6 pretty-midi==0.2.10 soundfile==0.13.1 music21==9.9.1
```

- [ ] **Step 3: 既存テストが全て通ることを確認する**

```bash
cd worker
for f in test_calibration test_confidence test_metrics test_reference test_teacher_metrics; do
  echo "--- $f ---"; python tests/$f.py 2>&1 | tail -3
done
```

Expected: 5ファイルすべて OK

- [ ] **Step 4: 結果を記録する（コミットは不要）**

インストールのみでリポジトリに変更は無い。Step 3 の出力を実行ログに残す。
`test_reference` が別の理由で落ちる場合は、この Task で原因を解消してから次へ進む。

---

### Task 5: `preprocess.py` に `dynamicRangeDb` を追加する

AGC 検出（`dynamics`）と劣化録音判定（`rhythm`）の入力となる。`m4-report.md` 5.1 は
clean/room/phone が 16 dB 以上、phone_agc が 7 dB 以下で明確に分離すると実測している。
単発ピークに左右されないよう、クレストファクタ（`peakDbfs − rmsDbfs`）ではなく
フレーム RMS のパーセンタイル差を使う。

**Files:**
- Modify: `worker/ledgerlines_worker/preprocess.py:44-98`
- Create: `worker/tests/test_preprocess.py`

**Interfaces:**
- Produces: `dynamic_range_db(audio: np.ndarray, sr: int) -> float`
- Produces: `preprocess()` の戻り値に `dynamicRangeDb: float` キーが加わる

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_preprocess.py`

```python
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.preprocess import dynamic_range_db  # noqa: E402

SR = 16000


def _tone(seconds: float = 4.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return np.sin(2 * np.pi * 440.0 * t).astype(np.float32)


class DynamicRangeTests(unittest.TestCase):
    def test_wide_dynamics_exceed_degraded_threshold(self):
        tone = _tone()
        envelope = np.linspace(0.02, 1.0, tone.size, dtype=np.float32)
        self.assertGreater(dynamic_range_db(tone * envelope, SR), 14.0)

    def test_compressed_audio_is_below_agc_threshold(self):
        self.assertLess(dynamic_range_db(_tone() * 0.5, SR), 10.0)

    def test_silence_returns_zero(self):
        self.assertEqual(dynamic_range_db(np.zeros(SR, dtype=np.float32), SR), 0.0)

    def test_shorter_than_one_frame_returns_zero(self):
        self.assertEqual(dynamic_range_db(np.ones(10, dtype=np.float32), SR), 0.0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd worker && python tests/test_preprocess.py`
Expected: FAIL — `ImportError: cannot import name 'dynamic_range_db'`

- [ ] **Step 3: 実装する**

`worker/ledgerlines_worker/preprocess.py` の `_dbfs`（`:45-46`）の直後に追加する。

```python
DYNAMIC_RANGE_FRAME_SEC = 0.05


def dynamic_range_db(audio: np.ndarray, sr: int) -> float:
    """フレームRMSの95/5パーセンタイル差(dB)。

    m4-report.md 5.1 の実測に対応する指標。単発のピークに左右されないよう、
    peak-rms のクレストファクタではなくフレームRMSの分布から求める。
    """
    frame = max(1, int(DYNAMIC_RANGE_FRAME_SEC * sr))
    usable = len(audio) - (len(audio) % frame)
    if usable < frame:
        return 0.0
    frames = np.asarray(audio[:usable], dtype=np.float64).reshape(-1, frame)
    rms = np.sqrt(np.mean(np.square(frames), axis=1))
    voiced = rms[rms > 0.0]
    if voiced.size == 0:
        return 0.0
    high = float(np.percentile(voiced, 95))
    low = float(np.percentile(voiced, 5))
    return round(_dbfs(high) - _dbfs(low), 2)
```

`preprocess()` の戻り値（`:91-98`）に追加する。`trimmed` を使う（無音除去後の信号で
評価する）。

```python
    return {
        "path": out_path,
        "rmsDbfs": round(rms_dbfs, 2),
        "peakDbfs": round(peak_dbfs, 2),
        "clippingRate": round(clipping_rate, 4),
        "dynamicRangeDb": dynamic_range_db(trimmed, sr),
        "durationSec": round(duration_sec, 2),
        "trimOffsetSec": round(trim_offset_sec, 3),
    }
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `cd worker && python tests/test_preprocess.py`
Expected: PASS（4 tests）

- [ ] **Step 5: コミットする**

```bash
git add worker/ledgerlines_worker/preprocess.py worker/tests/test_preprocess.py
git commit -m "feat: measure dynamic range for AGC and degraded-recording gates"
```

---

### Task 6: rhythm のデッドゾーンを録音品質で切り替える

`docs/spec/metrics.md:860` は劣化録音時に `d_r` を 0.03 → 0.045 拍に緩めると定めているが、
`metrics.py:16` は `DEAD_RHYTHM = 0.03` の固定値で未実装である。

**Files:**
- Modify: `worker/ledgerlines_worker/metrics.py:16,95-105,168-174`
- Modify: `worker/tests/test_metrics.py`

**Interfaces:**
- Produces: `DEAD_RHYTHM_DEGRADED = 0.045`、`DEGRADED_DYNAMIC_RANGE_DB = 14.0`
- Produces: `compute(..., degraded: bool = False)` — 既存呼び出しは後方互換

- [ ] **Step 1: 既存テストの形を確認する**

Run: `cd worker && sed -n '1,60p' tests/test_metrics.py`
既存の `compute()` 呼び出し方法とフィクスチャの作り方を読み、同じ流儀で新テストを書く。

- [ ] **Step 2: 失敗するテストを書く**

`worker/tests/test_metrics.py` に追記する。既存ファイルの import と補助関数を再利用し、
足りない場合は既存テストと同じ方法で参照譜と演奏を組み立てる。

```python
    def test_degraded_recording_widens_rhythm_dead_zone(self):
        """同じ演奏でも degraded=True なら rhythm のデッドゾーンが広く、点が下がらない。"""
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.04)

        strict = metrics_mod.compute(
            reference, est_notes, alignment, est_pedal=[], ref_pedal=[], degraded=False
        )
        lenient = metrics_mod.compute(
            reference, est_notes, alignment, est_pedal=[], ref_pedal=[], degraded=True
        )

        self.assertIsNotNone(strict["metrics"]["rhythm"])
        self.assertIsNotNone(lenient["metrics"]["rhythm"])
        self.assertGreater(lenient["metrics"]["rhythm"], strict["metrics"]["rhythm"])
```

`_rhythm_fixture(offset_beats)` は、参照譜の各音符を `offset_beats` だけ一律にずらさず
（一律ずれは中央値で吸収されるため）、音符ごとに交互に `±offset_beats` ずらした演奏を
返すヘルパーとして同じクラス内に実装する。デッドゾーンの差が出るよう、ずれ量は
0.03 と 0.045 の間の値（0.04）にする。

```python
    def _rhythm_fixture(self, offset_beats: float):
        ref_notes = [
            {
                "index": i,
                "pitch": 60 + (i % 3),
                "measure": 1,
                "startBeat": float(i),
                "dynamicLevel": None,
            }
            for i in range(8)
        ]
        reference = {
            "notes": ref_notes,
            "beatsPerMeasure": 8.0,
            "measures": [{"measure": 1, "tempoExcluded": False}],
            "capabilities": {"dynamics": False, "pedal": False},
        }
        # 1秒=1拍。奇数番目だけ後ろにずらすと中央値では吸収されない。
        est_notes = [
            {
                "index": i,
                "pitch": note["pitch"],
                "start": float(i) + (offset_beats if i % 2 else 0.0),
                "end": float(i) + 0.5,
                "velocity": 80,
            }
            for i, note in enumerate(ref_notes)
        ]
        alignment = {
            "pairs": [[i, i] for i in range(len(ref_notes))],
            "missed": [],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        return reference, est_notes, alignment
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `cd worker && python tests/test_metrics.py`
Expected: FAIL — `compute()` got an unexpected keyword argument `'degraded'`

引数 `ref_pedal` は Task 7 で `ref_pedal_beats` に改名する。この Task では現行名のまま
使い、Task 7 でテストも合わせて更新する。

- [ ] **Step 4: 実装する**

`worker/ledgerlines_worker/metrics.py:16` の直後に追加する。

```python
DEAD_RHYTHM = 0.03
DEAD_RHYTHM_DEGRADED = 0.045  # metrics.md:860 劣化録音時
DEGRADED_DYNAMIC_RANGE_DB = 14.0  # metrics.md:860
AGC_DYNAMIC_RANGE_DB = 10.0  # m4-report.md 5.1（AGC はこれ未満で断定できる）
```

`compute()` のシグネチャ（`:95-101`）に `degraded: bool = False` を追加する。

```python
def compute(
    reference: dict,
    est_notes: list[dict],
    alignment: dict,
    est_pedal: list[tuple[float, float]],
    ref_pedal: list[tuple[float, float]],
    degraded: bool = False,
) -> dict:
```

`:170` の `DEAD_RHYTHM` 参照をローカル変数に差し替える。`compute()` の冒頭
（`ref_notes = reference["notes"]` の直後）に置く。

```python
    dead_rhythm = DEAD_RHYTHM_DEGRADED if degraded else DEAD_RHYTHM
```

`:170` を変更する。

```python
            e_rhythm = float(np.sqrt(np.mean(np.maximum(0.0, np.abs(d) - dead_rhythm) ** 2)))
```

- [ ] **Step 5: テストを実行して通過を確認する**

Run: `cd worker && python tests/test_metrics.py`
Expected: PASS（既存テスト + 新規1件）

- [ ] **Step 6: コミットする**

```bash
git add worker/ledgerlines_worker/metrics.py worker/tests/test_metrics.py
git commit -m "feat: widen rhythm dead zone for degraded recordings"
```

---

### Task 7: 参照ペダル区間を配線する

`reference.py:86-98` は MusicXML から `pedalEvents`（拍位置と種別）を取り出しているが、
返却する参照譜（`:302-314`）には含めていない。`measures[].pedalMarks` は種別の集合のみで
位置情報を失っている。一方 `worker_main.py:290` は `ref_pedal=[]` をハードコードしており、
楽譜にペダル記号がある曲では「踏むほど減点される」計算になっている。

`pedalEvents` の位置は `_offset(item, part)`（quarterLength 単位）で、音符の `startBeat`
（`:123,279`）と同じ単位である。そのまま拍として扱える。

**既存の `reference.json` には `pedalEvents` が無い。** 曲ごとに1回だけ生成されるため、
既存曲は再生成しない限りキーが欠ける。欠ける場合は `pedal` を `unavailable`
（理由コード `PEDAL_REFERENCE_NOT_REGENERATED`）とし、既存曲の再生成は別作業とする。

**Files:**
- Modify: `worker/ledgerlines_worker/reference.py:302-314`
- Modify: `worker/ledgerlines_worker/metrics.py`（`compute()` の引数を拍単位に変更）
- Modify: `worker/tests/test_reference.py`
- Modify: `worker/tests/test_metrics.py`

**Interfaces:**
- Produces: 参照譜に `pedalEvents: list[tuple[float, str]]` が加わる
- Produces: `pedal_intervals_from_events(events, beats, secs) -> list[tuple[float, float]]`
  （`metrics.py`）
- Changes: `compute(..., ref_pedal_beats: list[tuple[float, float]], ...)` —
  Task 6 で追加した `ref_pedal` 引数を `ref_pedal_beats` に改名し、拍単位で受け取って
  内部で秒に変換する

- [ ] **Step 1: `pedalEvents` の実際の種別文字列を確認する**

Run: `cd worker && python -c "
from pathlib import Path
from ledgerlines_worker.reference import build_reference
ref = build_reference(Path('tests/fixtures/semantic-score.musicxml'))
print('keys:', sorted(ref.keys()))
print('capabilities:', ref['capabilities'])
print('measures[0]:', {k: v for k, v in ref['measures'][0].items() if 'pedal' in k.lower()})
"`

`pedalEvents` の種別文字列（`start` / `stop` / `sostenuto` 等）を実測で確認する。
フィクスチャにペダル記号が無い場合は、`semantic-score.musicxml` にペダル記号を追加した
新しいフィクスチャ `worker/tests/fixtures/pedal-score.musicxml` を作る。

- [ ] **Step 2: 失敗するテストを書く（reference 側）**

`worker/tests/test_reference.py` に追記する。

```python
    def test_reference_exposes_pedal_event_positions(self):
        reference = build_reference(FIXTURE_WITH_PEDAL)

        self.assertIn("pedalEvents", reference)
        events = reference["pedalEvents"]
        self.assertTrue(all(isinstance(offset, float) for offset, _ in events))
        # capabilities.pedal が真なら位置情報も存在しなければならない
        if reference["capabilities"]["pedal"]:
            self.assertGreater(len(events), 0)
```

`FIXTURE_WITH_PEDAL` は Step 1 で確定したフィクスチャのパスにする。

- [ ] **Step 3: 失敗するテストを書く（metrics 側）**

`worker/tests/test_metrics.py` に追記する。

```python
    def test_reference_pedal_is_compared_against_played_pedal(self):
        """参照ペダルと演奏ペダルが一致すれば pedal は高得点になる。"""
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.0)
        reference["capabilities"]["pedal"] = True

        # 拍0〜4にペダル。1拍=1秒なので秒でも 0.0〜4.0。
        result = metrics_mod.compute(
            reference,
            est_notes,
            alignment,
            est_pedal=[(0.0, 4.0)],
            ref_pedal_beats=[(0.0, 4.0)],
            degraded=False,
        )

        self.assertIsNotNone(result["metrics"]["pedal"])
        self.assertGreater(result["metrics"]["pedal"], 90.0)

    def test_pedal_penalised_when_player_omits_it(self):
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.0)
        reference["capabilities"]["pedal"] = True

        result = metrics_mod.compute(
            reference,
            est_notes,
            alignment,
            est_pedal=[],
            ref_pedal_beats=[(0.0, 4.0)],
            degraded=False,
        )

        self.assertIsNotNone(result["metrics"]["pedal"])
        self.assertLess(result["metrics"]["pedal"], 90.0)
```

Task 6 で `ref_pedal=[]` と書いたテストを、この Task で `ref_pedal_beats=[]` に更新する。

- [ ] **Step 4: テストを実行して失敗を確認する**

Run: `cd worker && python tests/test_reference.py && python tests/test_metrics.py`
Expected: どちらも FAIL — `pedalEvents` キーが無い / `compute()` が
`ref_pedal_beats` を受け取らない

- [ ] **Step 5: `reference.py` に `pedalEvents` を出力する**

`worker/ledgerlines_worker/reference.py` の返却辞書（`:302-314`）に追加する。
`context` は `build_reference` 内で組み立てられているため、その変数名を確認して参照する。

```python
        "pedalEvents": [(round(float(offset), 4), str(kind)) for offset, kind in context["pedalEvents"]],
```

`schemaVersion` は `"2.0"` のまま据え置く（キーの追加のみで既存の読み手を壊さない）。

- [ ] **Step 6: `metrics.py` で拍→秒変換を実装する**

`pedal_ratio`（`:78-82`）の直後に追加する。

```python
PEDAL_ON_KINDS = ("start", "sostenuto", "sustain", "mark")
PEDAL_OFF_KINDS = ("stop", "end")


def pedal_intervals_from_beats(
    intervals_beats: list[tuple[float, float]], beats: np.ndarray, secs: np.ndarray
) -> list[tuple[float, float]]:
    """拍単位のペダル区間をビートマップで秒に変換する。"""
    out: list[tuple[float, float]] = []
    for start_beat, end_beat in intervals_beats:
        t0 = measure_seconds(beats, secs, start_beat)
        t1 = measure_seconds(beats, secs, end_beat)
        if np.isnan(t0) or np.isnan(t1) or t1 <= t0:
            continue
        out.append((float(t0), float(t1)))
    return out


def pedal_intervals_from_events(events: list[tuple[float, str]]) -> list[tuple[float, float]]:
    """(拍, 種別) の列を拍単位の区間列にする。stop が無い start は最後の拍まで開いたまま扱う。"""
    intervals: list[tuple[float, float]] = []
    start: float | None = None
    for offset, kind in sorted(events, key=lambda item: float(item[0])):
        lowered = str(kind).lower()
        if any(token in lowered for token in PEDAL_OFF_KINDS):
            if start is not None:
                intervals.append((start, float(offset)))
                start = None
        elif any(token in lowered for token in PEDAL_ON_KINDS):
            if start is None:
                start = float(offset)
    if start is not None and events:
        intervals.append((start, float(max(float(offset) for offset, _ in events))))
    return intervals
```

`compute()` のシグネチャを変更する。

```python
def compute(
    reference: dict,
    est_notes: list[dict],
    alignment: dict,
    est_pedal: list[tuple[float, float]],
    ref_pedal_beats: list[tuple[float, float]],
    degraded: bool = False,
) -> dict:
```

`beats, secs = estimate_beat_map(...)`（`:105`）の直後に変換を挿入する。

```python
    ref_pedal = pedal_intervals_from_beats(ref_pedal_beats, beats, secs)
```

`:187` の `pedal_ratio(ref_pedal, t0, t1)` はそのまま動く。

- [ ] **Step 7: テストを実行して通過を確認する**

Run: `cd worker && python tests/test_reference.py && python tests/test_metrics.py`
Expected: どちらも PASS

- [ ] **Step 8: コミットする**

```bash
git add worker/ledgerlines_worker/reference.py worker/ledgerlines_worker/metrics.py worker/tests/test_reference.py worker/tests/test_metrics.py worker/tests/fixtures/
git commit -m "feat: compare played pedal against score pedal marks"
```

---

### Task 8: `confidence.py` を指標別ポリシーに置き換える

`confidence.py:262` の無条件 `overallScore = None` と、`pitch` / `rhythm` / `dynamics` /
`pedal` の一律 `withheld`（`:155-175`）を、spec 4.1 / 4.7 の指標別ポリシーに置き換える。

**Files:**
- Modify: `worker/ledgerlines_worker/confidence.py`
- Modify: `worker/tests/test_confidence.py`

**較正 artifact の扱い（重要）:** 従来 `tempo` は artifact の
`thresholds.tempo.minimumConfidence` と `alignmentConfidence` の比較で `scored` /
`withheld` が決まっていた（`confidence.py:112-153`）。本 Task 以降、`tempo` は M4 の
頑健性実測により無条件で `scored` になるため、**この閾値は指標のゲートとして使われなく
なる**。`calibration.py` とその release gate、`test_calibration.py` は変更せずそのまま残す
（spec 3章の非目標。教師較正は今後の高度評価のために保持する）。`calibrationVersion` は
`diagnostics` と `evaluation` に引き続き記録する。アライメントのゲートは
`MIN_MATCH_RATE` のみになる。

**Interfaces:**
- Consumes: `reference["capabilities"]`、`alignment`、`preprocess` の `dynamicRangeDb`
- Produces: `apply_fail_closed_policy(result, reference, alignment, transcribed_note_count,
  calibration=None, *, dynamic_range_db: float | None = None,
  pedal_reference_available: bool = False) -> dict`
- Produces: 新しい理由コード `PITCH_FORMULA_UNVALIDATED`、`AGC_DETECTED`、
  `PEDAL_REFERENCE_NOT_REGENERATED`、`ALIGNMENT_BELOW_FLOOR`
- Produces: `MIN_MATCH_RATE = 0.30`

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_confidence.py` に追記する。既存の
`test_issue_8_diagnostic_is_withheld_without_calibration` は前提が変わるため、
`test_issue_8_diagnostic_withholds_pitch_only` に置き換える。

```python
    def test_issue_8_diagnostic_withholds_pitch_only(self):
        """段2 では pitch だけが保留になり、他4指標は採点される。"""
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result,
            reference,
            alignment,
            1495,
            None,
            dynamic_range_db=18.0,
            pedal_reference_available=False,
        )

        self.assertEqual(guarded["metricEvaluations"]["pitch"]["status"], "withheld")
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "PITCH_FORMULA_UNVALIDATED"
        )
        self.assertEqual(guarded["metricEvaluations"]["rhythm"]["status"], "scored")
        self.assertEqual(guarded["metricEvaluations"]["tempo"]["status"], "scored")
        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["status"], "scored")
        # 参照ペダルが未再生成なので測定対象外
        self.assertEqual(guarded["metricEvaluations"]["pedal"]["status"], "unavailable")
        self.assertEqual(
            guarded["metricEvaluations"]["pedal"]["reasonCode"],
            "PEDAL_REFERENCE_NOT_REGENERATED",
        )

    def test_overall_score_is_withheld_while_pitch_is_unvalidated(self):
        """withheld が1つでも残れば総合点は出さない（spec 4.7）。"""
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=18.0
        )

        self.assertIsNone(guarded["overallScore"])
        self.assertEqual(guarded["evaluation"]["status"], "withheld")

    def test_agc_makes_dynamics_unavailable(self):
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=7.0
        )

        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["status"], "unavailable")
        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["reasonCode"], "AGC_DETECTED")

    def test_low_match_rate_is_rejected(self):
        """別の曲の音声が来た場合にスコアを出さない安全網。"""
        result, reference, alignment = self._issue8_case()
        alignment["pairs"] = alignment["pairs"][:100]  # matchRate 約 0.08

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=18.0
        )

        self.assertTrue(guarded["alignmentBelowFloor"])
        self.assertIsNone(guarded["overallScore"])
        for key in ("pitch", "rhythm", "tempo", "dynamics", "pedal"):
            self.assertIn(
                guarded["metricEvaluations"][key]["status"], {"withheld", "unavailable"}
            )
```

`_issue8_case()` を同じクラスに実装する。既存テストのフィクスチャ組み立てを切り出し、
`capabilities` と `measures` を足したものである。

```python
    def _issue8_case(self):
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "issue8_take_diagnostic.json").read_text(
                encoding="utf-8"
            )
        )
        measure_count = fixture["referenceNotes"] // 12 + 1
        reference = {
            "notes": [
                {"index": index, "measure": index // 12 + 1}
                for index in range(fixture["referenceNotes"])
            ],
            "measures": [
                {"measure": measure, "tempoExcluded": False}
                for measure in range(1, measure_count + 1)
            ],
            "capabilities": {"dynamics": True, "pedal": True},
        }
        alignment = {
            "pairs": [[index, index] for index in range(fixture["matchedNotes"])],
            "missed": list(range(fixture["matchedNotes"], fixture["referenceNotes"])),
            "extra": list(range(fixture["extraNotes"])),
            "retakes": [],
            "unplayed": [],
        }
        raw = fixture["rawScores"]
        result = {
            "overallScore": raw["overallScore"],
            "metrics": dict(raw["metrics"]),
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 12,
                    "score": 40,
                    "metrics": {
                        "pitch": 9.99,
                        "rhythm": 63.3,
                        "tempo": 95.93,
                        "dynamics": 98.58,
                        "pedal": None,
                    },
                }
            ],
        }
        return result, reference, alignment
```

フィクスチャの `rawScores.metrics.pedal` は `null` だが、`decide()` が
`pedal_reference_available` を素点の有無より先に見るため、理由コードは
`PEDAL_REFERENCE_NOT_REGENERATED` になる。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd worker && python tests/test_confidence.py`
Expected: FAIL — `apply_fail_closed_policy()` が `dynamic_range_db` を受け取らない

- [ ] **Step 3: 理由コードを追加する**

`worker/ledgerlines_worker/confidence.py:15-23` の `REASONS` に追加する。

```python
    "PITCH_FORMULA_UNVALIDATED": "音程の指標式が採譜ノイズに影響されることが判明しているため、式の検証が完了するまで判定を保留します。",
    "AGC_DETECTED": "自動ゲイン制御がかかった録音のため、強弱を測定できません。",
    "PEDAL_REFERENCE_NOT_REGENERATED": "この曲の参照譜にペダル位置が含まれていないため測定できません。楽譜を再登録すると測定できます。",
    "ALIGNMENT_BELOW_FLOOR": "楽譜と演奏の対応付けが成立していないため採点できません。別の曲の録音でないかご確認ください。",
    "ROBUSTNESS_VALIDATED": "録音条件に対する頑健性が実測で確認されている指標です。",
```

閾値を定義する。

```python
MIN_MATCH_RATE = 0.30  # spec 4.7。別曲の音声を弾いた場合の安全網
```

**AGC 閾値は Task 6 で `metrics.py` に定義した `AGC_DYNAMIC_RANGE_DB` を import して使う。
`confidence.py` に複製しないこと。** Step 4 で `WEIGHTS` と併せて import する。

- [ ] **Step 4: 指標別ポリシーを実装する**

`apply_fail_closed_policy` を書き換える。`overall_evidence` / `by_measure` /
`diagnostics` / `raw_scores` の組み立て（`:99-110`）はそのまま残し、`:112` 以降の
判定部分を差し替える。

```python
def apply_fail_closed_policy(
    result: dict,
    reference: dict,
    alignment: dict,
    transcribed_note_count: int,
    calibration: dict | None = None,
    *,
    dynamic_range_db: float | None = None,
    pedal_reference_available: bool = False,
) -> dict:
    """指標ごとに、実測された頑健性に基づいて採点可否を決める。

    m4-report.md 5章の実測（clean 基準の差）:
        tempo -2.7/-1.9/-3.2、pedal -4.5/-5.0、dynamics -5.7/-9.0/-45.1(AGC)、
        rhythm -11.8/-6.6/-14.7、pitch -37.7/-37.6/-50.0
    pitch のみ式が採譜ノイズに支配されるため保留する（段3で対応）。
    """
    overall_evidence, by_measure = alignment_evidence(reference, alignment)
    diagnostics = {
        **overall_evidence,
        "transcribedNotes": transcribed_note_count,
        "dynamicRangeDb": dynamic_range_db,
        "calibrationStatus": "approved" if calibration else "missing",
        "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        "calibrationArtifactHash": calibration.get("artifactHash") if calibration else None,
    }
    raw_scores = {
        "overallScore": result.get("overallScore"),
        "metrics": dict(result.get("metrics", {})),
    }
    capabilities = reference.get("capabilities", {})
    alignment_confidence = overall_evidence["alignmentConfidence"]
    below_floor = overall_evidence["matchRate"] < MIN_MATCH_RATE
    agc = dynamic_range_db is not None and dynamic_range_db < AGC_DYNAMIC_RANGE_DB

    def decide(key: str) -> tuple[str, str]:
        """(status, reasonCode) を返す。

        指標固有の「測定対象外」判定を先に行う。参照譜にペダル位置が無いことや
        AGC がかかっていることは素点の有無に関わらず確定しており、
        「対応付け根拠不足」より具体的な理由だからである。
        """
        if below_floor:
            return "withheld", "ALIGNMENT_BELOW_FLOOR"
        if key == "dynamics":
            if not capabilities.get("dynamics"):
                return "unavailable", "NO_SCORE_DYNAMICS"
            if agc:
                return "unavailable", "AGC_DETECTED"
        if key == "pedal":
            if not capabilities.get("pedal"):
                return "unavailable", "NO_SCORE_PEDAL"
            if not pedal_reference_available:
                return "unavailable", "PEDAL_REFERENCE_NOT_REGENERATED"
        if raw_scores["metrics"].get(key) is None:
            return "unavailable", "INSUFFICIENT_ALIGNMENT_EVIDENCE"
        if key == "pitch":
            return "withheld", "PITCH_FORMULA_UNVALIDATED"
        return "scored", "ROBUSTNESS_VALIDATED"

    decisions = {key: decide(key) for key in METRICS}
    metric_evaluations = {
        key: _evaluation(
            status,
            reason_code,
            alignment_confidence if status == "scored" else None,
            diagnostics,
        )
        for key, (status, reason_code) in decisions.items()
    }
```

小節ループ（`:177-260`）を、指標別の判定を反映する形に単純化する。

```python
    for measure_score in result["measureScores"]:
        measure = int(measure_score["measure"])
        evidence = by_measure.get(
            measure,
            {
                "referenceNotes": measure_score.get("refNotes", 0),
                "matchedNotes": 0,
                "matchRate": 0.0,
                "anchorQuality": 0.0,
                "alignmentConfidence": 0.0,
            },
        )
        measure_metrics = dict(measure_score["metrics"])
        measure_score["scoreMeasure"] = measure
        measure_score["noteCount"] = measure_score.pop("refNotes", evidence["referenceNotes"])
        measure_score["confidence"] = evidence["alignmentConfidence"]
        measure_score["metrics"] = {
            key: (measure_metrics.get(key) if decisions[key][0] == "scored" else None)
            for key in METRICS
        }
        measure_score["metricEvaluations"] = {
            key: _evaluation(
                decisions[key][0] if measure_metrics.get(key) is not None else "unavailable",
                decisions[key][1]
                if measure_metrics.get(key) is not None
                else "INSUFFICIENT_ALIGNMENT_EVIDENCE",
                evidence["alignmentConfidence"] if decisions[key][0] == "scored" else None,
                evidence,
            )
            for key in METRICS
        }
        scored = {
            key: weight
            for key, weight in WEIGHTS.items()
            if measure_score["metrics"][key] is not None
        }
        total = sum(scored.values())
        measure_score["score"] = (
            round(
                sum(measure_score["metrics"][key] * weight for key, weight in scored.items())
                / total,
                2,
            )
            if total
            else None
        )
```

`WEIGHTS` を `metrics` モジュールから import する。`confidence.py` の先頭に追加する。

```python
from .metrics import AGC_DYNAMIC_RANGE_DB, WEIGHTS
```

総合点の算出（`:262-287`）を spec 4.7 の規則に置き換える。

```python
    result["metrics"] = {
        key: (raw_scores["metrics"].get(key) if decisions[key][0] == "scored" else None)
        for key in METRICS
    }
    has_withheld = any(status == "withheld" for status, _ in decisions.values())
    scored_weights = {
        key: weight
        for key, weight in WEIGHTS.items()
        if decisions[key][0] == "scored" and result["metrics"][key] is not None
    }
    total_weight = sum(scored_weights.values())
    result["overallScore"] = (
        None
        if has_withheld or not total_weight
        else round(
            sum(result["metrics"][key] * weight for key, weight in scored_weights.items())
            / total_weight,
            2,
        )
    )
    result["metricConfidence"] = {
        key: (alignment_confidence if decisions[key][0] == "scored" else None)
        for key in METRICS
    }
    result["metricEvaluations"] = metric_evaluations
    result["metricsNAReason"] = {
        key: evaluation["reason"]
        for key, evaluation in metric_evaluations.items()
        if evaluation["status"] != "scored"
    }
    result["alignmentBelowFloor"] = below_floor
    if result["overallScore"] is not None:
        result["evaluation"] = {
            "status": "scored",
            "confidence": alignment_confidence,
            "reasonCode": "ROBUSTNESS_VALIDATED",
            "reason": REASONS["ROBUSTNESS_VALIDATED"],
            "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        }
    else:
        reason_code = "ALIGNMENT_BELOW_FLOOR" if below_floor else "PITCH_FORMULA_UNVALIDATED"
        result["evaluation"] = {
            "status": "withheld",
            "confidence": alignment_confidence,
            "reasonCode": reason_code,
            "reason": REASONS[reason_code],
            "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        }
    result["diagnostics"] = diagnostics
    return result
```

**注意:** 循環 import に注意する。`metrics.py` は `confidence.py` を import していない
ことを確認してから `from .metrics import WEIGHTS` を追加する。循環する場合は
`WEIGHTS` を `confidence.py` 内に複製せず、共通の定数モジュールへ移す。

- [ ] **Step 5: テストを実行して通過を確認する**

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS

- [ ] **Step 6: `issues.py` が新しい status で動くことを確認する**

`issues.py:96` は `status == "scored"` の指標のみ指摘を生成する。段2 では
rhythm / tempo / dynamics / pedal が `scored` になるため指摘が生成されるようになる。
`test_confidence.py` の既存の `generate_issues` 呼び出しテストが通ることを確認する。

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS

- [ ] **Step 7: コミットする**

```bash
git add worker/ledgerlines_worker/confidence.py worker/tests/test_confidence.py
git commit -m "feat: score metrics individually by measured robustness"
```

---

### Task 9: ワーカー本体を配線する

**Files:**
- Modify: `worker/worker_main.py:286-295`
- Modify: `worker/cloud_worker.py`（`process_job` の該当箇所）

**Interfaces:**
- Consumes: `preprocess()` の `dynamicRangeDb`（Task 5）、`reference["pedalEvents"]`（Task 7）、
  `apply_fail_closed_policy` の新しいキーワード引数（Task 8）

- [ ] **Step 1: `worker_main.py` を書き換える**

`:286-295` を次に置き換える。

```python
        est_notes_full, est_pedal = metrics_mod.load_est(midi_path)
        dynamic_range_db = pre.get("dynamicRangeDb")
        degraded = (
            dynamic_range_db is not None
            and dynamic_range_db < metrics_mod.DEGRADED_DYNAMIC_RANGE_DB
        )
        pedal_events = reference.get("pedalEvents")
        ref_pedal_beats = (
            metrics_mod.pedal_intervals_from_events(pedal_events) if pedal_events else []
        )
        result = metrics_mod.compute(
            reference,
            est_notes_full,
            alignment,
            est_pedal,
            ref_pedal_beats=ref_pedal_beats,
            degraded=degraded,
        )
        calibration = calibration_mod.load_calibration()
        result = confidence_mod.apply_fail_closed_policy(
            result,
            reference,
            alignment,
            len(est_notes_full),
            calibration,
            dynamic_range_db=dynamic_range_db,
            pedal_reference_available=bool(pedal_events),
        )
```

- [ ] **Step 2: アライメント下限で `failed` にする**

`generate_issues` 呼び出しの直前に追加する。

```python
        if result.get("alignmentBelowFloor"):
            update({
                "status": "failed",
                "failure": {
                    "code": "ALIGN_FAILED",
                    "message": result["evaluation"]["reason"],
                },
                "analysis": {
                    "pipelineVersion": "0.3.0-m5-metric-policy",
                    "diagnostics": result["diagnostics"],
                },
            })
            print(json.dumps({"ok": False, "code": "ALIGN_FAILED", "takeId": take_id}))
            return 1
```

`take-state.ts` の状態機械が `scoring → failed` を許すことを確認する。

Run: `grep -n "scoring" src/lib/server/take-state.ts`

- [ ] **Step 3: `pipelineVersion` を更新する**

`worker_main.py` の `"pipelineVersion": "0.2.0-m5-confidence-guard"` を
`"0.3.0-m5-metric-policy"` に変更する。`calibration-runbook.md` 46-51行の規定により、
異なる pipelineVersion 間の差分は改善量として表示してはならない。

- [ ] **Step 4: `cloud_worker.py` を同じ形に揃える**

`process_job` 内の `compute` / `apply_fail_closed_policy` 呼び出しを Step 1 と同じ
引数に揃える。`sync_local_doc` の同期キー一覧（`:93-110`）に
`alignmentBelowFloor` を含める必要があるかを確認する（`TakeDoc` に保存しないなら不要）。

Run: `grep -n "apply_fail_closed_policy\|compute(" worker/cloud_worker.py`

- [ ] **Step 5: ワーカーのテストを全て実行する**

```bash
cd worker
for f in test_calibration test_confidence test_metrics test_preprocess test_reference test_teacher_metrics; do
  echo "--- $f ---"; python tests/$f.py 2>&1 | tail -3
done
```

Expected: 6ファイルすべて OK

- [ ] **Step 6: コミットする**

```bash
git add worker/worker_main.py worker/cloud_worker.py
git commit -m "feat: wire recording quality and score pedal into the analysis pipeline"
```

---

### Task 10: 型と文書を更新する

**Files:**
- Modify: `src/lib/server/types.ts:60`（必要なら理由コードの型）
- Modify: `docs/spec/metrics.md`（3.2 / 3.4 / 7.2 / 7.3 / 9）
- Modify: `docs/spec/api.md`（1章）
- Modify: `docs/design/analysis-pipeline.md`（6.4 / 7.1）
- Modify: `worker/README.md`

- [ ] **Step 1: TypeScript 側の型を確認する**

`EvaluationStatus`（`src/lib/server/types.ts:60`）は
`"scored" | "reference" | "withheld" | "unavailable"` で新しい status を追加しないため
変更不要。`reasonCode` は `string | null` なので新コードも表現できる。
`TakeEvaluationDoc.status` は `"scored" | "withheld"` で足りる。

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 2: `docs/spec/metrics.md` を更新する**

- 3.2 rhythm — `d_r` の実装と切り替え条件（`dynamicRangeDb < 14`）を追記する
- 3.4 dynamics — `dynamicRangeDb` の定義（フレーム RMS の p95−p5）と AGC 判定
  （`< 10`、`m4-report.md` 5.1 の実測）を追記する
- 7.2 — Issue #8 の一律保留の記述を、指標別の扱い（spec 4.1 の表）に置き換える。
  pitch のみ `PITCH_FORMULA_UNVALIDATED` で保留していることと、その理由
  （余剰音が誤りの 58% を占め、τ=0.15 が支配的）を書く
- 7.3 — `matchRate < 0.30` を `ALIGN_FAILED` とする実装を追記する。既存の
  `takeConfidence < 0.5` は未較正の設計仮説として据え置く旨を明記する
- 9 / 922行 — τ の教師較正は **未** のままであることを明記する

- [ ] **Step 3: `docs/spec/api.md` を更新する**

1章の追記部分（`unavailable` / `withheld` の区別）に、総合点への影響を足す。
`withheld` が1つでも残れば `overallScore` は `null`、`unavailable` は加重平均から
除外して残りの重みを再配分する。

- [ ] **Step 4: `docs/design/analysis-pipeline.md` を更新する**

7.1 の「低信頼な指標を除外して残りの重みで総合点を再計算することはしない」を、
`unavailable`（欠測）は除外して再配分する / `withheld`（低信頼）が残れば総合点を出さない、
という形に改訂する。6.4 の `alignmentConfidence` の記述に `MIN_MATCH_RATE` を追記する。

- [ ] **Step 5: `worker/README.md` を更新する**

- 「`reference.py` はMusicXMLからペダル記号を抽出していない」という記述を削除する。
  抽出済みであり、`pedalEvents` として参照譜に出力し `pedal_ratio` の参照側に使うと書く。
  既存曲の `reference.json` には `pedalEvents` が無いため再生成が必要である旨を書く
- フェイルクローズの記述を、pitch のみ保留・他4指標は採点、に差し替える
- `pipelineVersion` が `0.3.0-m5-metric-policy` になったことを書く

- [ ] **Step 6: 全テストを実行する**

```bash
npx tsc --noEmit && npm run lint && npx tsx --test src/lib/real-history.test.ts
cd worker
for f in test_calibration test_confidence test_metrics test_preprocess test_reference test_teacher_metrics; do
  echo "--- $f ---"; python tests/$f.py 2>&1 | tail -3
done
```

Expected: すべて成功

- [ ] **Step 7: コミットする**

```bash
git add src/lib/server/types.ts docs/spec/metrics.md docs/spec/api.md docs/design/analysis-pipeline.md worker/README.md
git commit -m "docs: record per-metric scoring policy and pedal reference wiring"
```

---

## 完了条件

- `/progress` `/share` `/coach` のいずれにも「0点」が表示されない
- `/takes/real/[takeId]` で `tempo` / `rhythm` / `dynamics` が数値バーとして表示される
  （AGC 録音では `dynamics` が「測定対象外」）
- ペダル記号のある楽譜を再登録したテイクで `pedal` が数値バーとして表示される
- `pitch` が「判定保留」＋式未検証の理由文として表示される
- `overallScore` は `null` のまま（段3 で復帰）
- 別の曲の音声を投稿したテイクが `failed (ALIGN_FAILED)` になる
- ワーカーのテスト6ファイルと TS のテスト・型チェック・lint がすべて通る

## 次の計画（段3）

`docs/superpowers/specs/2026-08-15-restore-performance-scores-design.md` の 4.2 / 4.3 と
5.1 / 5.2 を対象に、MAESTRO データ取得後に別計画を作る。内容は extra 音符のノイズ分類、
`TAU_PITCH` / `W_EXTRA` の再校正、`perturb.py` / `degrade.py` による検証、
`overallScore` の復帰である。
