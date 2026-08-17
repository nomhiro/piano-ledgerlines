# 実データのテイク詳細に小節スコアの重ね合わせを配線する 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/takes/real/{takeId}`（実データのテイク詳細）で、テイクの小節スコアを OSMD が描いた
MusicXML の楽譜に重ねて表示する。あわせて、重ねる前に直しておかないと `null`（判定保留）を
最低点の赤として描いてしまう `ScoreView` の欠陥を修正する。

**Architecture:** `ScoreView`（OSMD 描画 + ヒートマップ重ね合わせ）は既に存在し、実データの
MusicXML 配信経路（`GET /api/songs/{songId}/score/file`）も `/songs/{song_...}` の
`ScorePreview` 経由で動作実績がある。不足しているのは実データのページからの呼び出しだけなので、
新しい描画ロジックは書かない。ただし `ScoreView` は「モック専用の前提」を3つ抱えている
（mock 型への依存 / `null` を NaN にする実装 / デモ用サンプル楽譜の注記がハードコード）ため、
実データを流す前にそれらを外す。DOM に依存しないスコア対応表の計算は純関数として切り出し、
プロジェクト既存の `tsx --test` で回帰テストを書く。

**Tech Stack:** Next.js 16.2.11（App Router / Client Components）、React 19、TypeScript、
opensheetmusicdisplay 2.1、Node.js 組み込みテストランナー（`npx tsx --test`）、Tailwind CSS 4。

**Spec:** GitHub Issue #35 <https://github.com/nomhiro/piano-ledgerlines/issues/35>
（別途の spec 文書は無い。イシューの記述と、下記「調査で確定した事実」がこの計画の根拠）

## 調査で確定した事実

イシューの記述に加えて、実装前に知っておく必要がある事実。

1. **根本原因は未配線。** `ScoreView` の呼び出しは `ScorePreview.tsx:93` /
   `SongDetailView.tsx:71` / `TakeAnalysisView.tsx:189` の3箇所だけで、実データのページ
   （`src/app/progress/page.tsx:75`、`src/app/takes/real/[takeId]/page.tsx:78`）は
   `TakeEvaluationPanel` のみを描いている。
2. **実データの楽譜描画自体は既に動いている。** `src/app/songs/[id]/page.tsx:97-104` が実データの
   曲詳細で `ScorePreview` → `ScoreView`（`showHeatmap={false}`）を描画済み。配信 API の
   Content-Type は `application/vnd.recordare.musicxml+xml` なので `ScoreView.tsx:61` の
   `includes("xml")` 判定でテキスト経路に入る。認証は Easy Auth がヘッダーを注入するため
   ブラウザからの素の `fetch` で通る。
3. **`null` を渡すと最低点の赤で塗られる（配線前に直す）。** `ScoreView.tsx:32-39` は
   `measureScores` を `"12:null"` のような文字列に落として `Number()` で戻すため、
   `Number("null")` = `NaN` になる。`scoreMap.has()` は true を返すのでオーバーレイの
   `score` は `null` にならず `NaN`、`scoreColor(NaN)` は全比較が false で最低点の赤
   `#ef4444` を返し、ツールチップは `NaN点` になる。モックの `MeasureScore.score` は
   `number` なので今まで露出していない。
4. **オーバーレイは `scoreMeasure` で引く。** 小節番号は2系統ある（`docs/spec/api.md:72`、
   `docs/spec/metrics.md:56-57`）。`measure` は繰り返し展開後の演奏順、`scoreMeasure` は
   楽譜上の番号。OSMD が描くのは楽譜そのものなので、重ね合わせは `scoreMeasure` を使う。
   現在のワーカーは `hasRepeats: False` 固定（`worker/worker_main.py:177`）で両者が一致する
   ため今日の実データでは差が出ないが、契約は分かれているので分かれたまま扱う。
5. **`scoreUrl` は実データでも取得できる。** `GET /api/songs/{songId}` は `SongDoc` を
   そのまま返す（`src/app/api/songs/[songId]/route.ts:18`）ので `previewScoreFileName` は
   実際にレスポンスに含まれている。クライアント側の `ApiSong` 型に宣言が無いだけ。
6. **ローカルで再現・検証できる。** `npm run dev` の既定は `authMode: development` /
   `repositoryBackend: local` / `devUserId: usr_local_dev` / `dataDir: <repo>/.data`
   （`src/lib/server/config.ts:84-111`）で、ローカルリポジトリは JSON をそのまま読む
   （`src/lib/server/repository.ts:371-378`）。よって `.data/` に手書きの曲・テイクを置けば
   Python もコンテナも無しで `/takes/real/{id}` を再現できる。エミュレータプロファイル
   （`npm run azure:up`）は楽譜登録ができない（`worker/README.md`、コミット `175c8a4`）ので
   この検証には使えない。

## Global Constraints

- **`/progress` には楽譜ビューを置かない。** 一覧はテイクを全件縦に並べるため、テイク数ぶんの
  OSMD インスタンスが立つ。楽譜ビューは `/takes/real/{takeId}` のみ（決定事項）。
- **`TakeEvaluationPanel` の「小節ごとのスコア」数字グリッドは残す。** 楽譜が無い曲
  （`previewScoreFileName` が `null`）や OSMD 描画失敗時のフォールバックであり、判定保留の
  小節を斜線で明示している唯一の表示でもある（決定事項）。`TakeEvaluationPanel.tsx` は
  この計画では変更しない。
- **小節クリックによる絞り込みは実装しない。** 楽譜ビューは表示専用（色 + ツールチップ）。
  `onSelectMeasure` を渡さない（決定事項）。別 Issue に切り出す（Task 5）。
- **`null` を 0 点・最低点として描いてはならない。** #29 で数字グリッド側は直っている。
  楽譜オーバーレイでも「採点済み」「判定保留」「このテイクの対象外」を区別して描く。
- **`ScoreView` を mock 型に依存させない。** 既存計画
  `docs/superpowers/plans/2026-08-15-restore-performance-scores.md` の制約どおり、実データを
  mock 用コンポーネントに流さない。`src/lib/mock/types.ts` の `MeasureScore` は
  `score: number`・`metrics` 必須で実データの `null` を表現できないため、`ScoreView` は
  自分のプロパティ型を持つ共有コンポーネントにする。`src/lib/mock/` は変更しない。
- **モック画面の見た目・文言を変えない。** `/takes/take-cw-1` と
  `/songs/chopin-waltz-64-2` の表示は現状と同一にする（デモ用注記の文言も含む）。
- `AGENTS.md` の指示: `src/app/**` の App Router コードを書く前に
  `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
  と `06-fetching-data.md` を読むこと。この版の Next.js は訓練データと API・規約が異なる。
- 型チェックは `npx tsc --noEmit`（この計画の開始時点でクリーン）、Lint は `npm run lint`。
- 作業ブランチは `origin/main`（`9bb5349`）から切る。このワークツリーの
  `fix/azure-local-emulator-init` は既に `origin/main` にマージ済み。

## File Structure

| ファイル | 役割 |
|---|---|
| `src/components/score-overlay.ts`（新規） | 小節スコアを「楽譜上の小節番号 → スコア」の対応表に畳む純関数。DOM・OSMD・React に依存しない。`null` の扱いがここに集約される。 |
| `src/components/score-overlay.test.ts`（新規） | 上記の回帰テスト（`npx tsx --test`）。 |
| `src/components/ScoreView.tsx`（変更） | mock 型依存の除去、`null` 経路の修正、注記の外出し、非インタラクティブ時のガード。 |
| `src/components/TakeAnalysisView.tsx`（変更） | デモ用注記を呼び出し側から渡す（見た目は不変）。 |
| `src/components/SongDetailView.tsx`（変更） | 同上。 |
| `src/lib/api/client.ts`（変更） | `ApiSong` に `previewScoreFileName` / `scoreSource`、`ApiTakeDetail.measureScores` に `scoreMeasure` を宣言（いずれも API が既に返しているフィールド）。 |
| `src/components/TakeScoreCard.tsx`（新規） | 実データのテイク詳細用。曲を取得して楽譜 URL を決め、`ScoreView` をカードに載せる。楽譜が無い／取得できない場合は何も描かない。 |
| `src/app/takes/real/[takeId]/page.tsx`（変更） | `TakeScoreCard` を設置。 |

---

### Task 0: ローカルに実データ形状のテイクを用意し、事象を再現する

実装前に、修正の前後を比べられる状態を作る。コード変更は無い。`.data/` は `.gitignore` 済み
（`.gitignore:48`）なのでコミットしない。ここで作ったデータは Task 4 でそのまま使う。

**Files:**
- Create（git 管理外）: `.data/songs/song_local_check.json`、
  `.data/scores/song_local_check/preview.musicxml`、`.data/takes/take_local_check.json`

**Interfaces:**
- Consumes: なし
- Produces: `http://localhost:3000/takes/real/take_local_check` で開けるテイク。
  1小節目=高得点 / 2小節目=低得点 / 3小節目=判定保留 / 4小節目以降=記録なし。
  Task 4 がこの4種類の見え方を確認する。

- [ ] **Step 1: 検証用の曲とテイクを `.data/` に置く**

`preview.musicxml` はモック用の16小節サンプルを流用する（Bash ツールで実行する）:

```bash
mkdir -p .data/songs .data/takes .data/scores/song_local_check
cp public/scores/etude-in-a-minor.musicxml .data/scores/song_local_check/preview.musicxml
```

`.data/songs/song_local_check.json`:

```json
{
  "id": "song_local_check",
  "userId": "usr_local_dev",
  "title": "重ね合わせ確認用",
  "composer": "check",
  "targetTempo": 96,
  "targetDate": null,
  "status": "ready",
  "measureCount": 16,
  "scoreMeasureCount": 16,
  "keySignature": "a minor",
  "timeSignature": "4/4",
  "detectedTempo": 96,
  "hasRepeats": false,
  "warnings": [],
  "scoreFileName": "source.musicxml",
  "sourceScoreFileName": "source.musicxml",
  "scoreSource": "musicxml",
  "omrEngine": null,
  "previewScoreFileName": "preview.musicxml",
  "previewMidiFileName": null,
  "createdAt": "2026-08-16T10:00:00+09:00",
  "updatedAt": "2026-08-16T10:00:00+09:00"
}
```

`.data/takes/take_local_check.json`（1小節目は高得点、2小節目は低得点、3小節目は判定保留、
4小節目以降は記録なし = このテイクの対象外。3つの見え方を1画面で確認するための配置）:

```json
{
  "id": "take_local_check",
  "userId": "usr_local_dev",
  "songId": "song_local_check",
  "label": "確認テイク",
  "recordedAt": "2026-08-16T10:05:00+09:00",
  "durationSec": 30,
  "requestedMeasureRange": [1, 16],
  "playedMeasureRange": [1, 3],
  "requestedTempo": 96,
  "inputKind": "audio",
  "contentType": "audio/wav",
  "status": "completed",
  "progress": 100,
  "failure": null,
  "overallScore": null,
  "metrics": { "pitch": null, "rhythm": 74, "tempo": 81, "dynamics": null, "pedal": null },
  "metricConfidence": { "pitch": null, "rhythm": 0.8, "tempo": 0.9, "dynamics": null, "pedal": null },
  "metricEvaluations": {},
  "metricsNAReason": {},
  "evaluation": null,
  "measureScores": [
    { "measure": 1, "scoreMeasure": 1, "score": 91, "confidence": 0.9, "metrics": {}, "metricEvaluations": {}, "noteCount": 8 },
    { "measure": 2, "scoreMeasure": 2, "score": 38, "confidence": 0.8, "metrics": {}, "metricEvaluations": {}, "noteCount": 8 },
    { "measure": 3, "scoreMeasure": 3, "score": null, "confidence": null, "metrics": {}, "metricEvaluations": {}, "noteCount": 8 }
  ],
  "issues": [],
  "aiReview": null,
  "analysis": null,
  "memo": "",
  "createdAt": "2026-08-16T10:05:00+09:00",
  "updatedAt": "2026-08-16T10:05:00+09:00"
}
```

- [ ] **Step 2: 事象を再現する（楽譜が出ないことを確認する）**

Run: `npm run dev`（別シェルで起動したまま Task 1 以降も使う）
`http://localhost:3000/takes/real/take_local_check` を開いて確認する:
- 5指標のバーと「小節ごとのスコア」数字グリッドは出る（データが読めている証拠）。
- **楽譜が描画されていない** = Issue #35 の事象。
- 数字グリッドの3小節目が斜線（判定保留）になっている。#29 の修正が効いている側。

- [ ] **Step 3: 曲詳細では実データの楽譜が既に描けることを確認する**

`http://localhost:3000/songs/song_local_check` を開く。「変換後の楽譜」に楽譜が描かれる
（`ScorePreview` 経由）。ここが描けていれば、MusicXML の配信と OSMD 描画は正常で、
残りの問題はテイク側の配線だけだと確定できる。描けない場合はこの計画を進める前に
`/api/songs/song_local_check/score/file` のレスポンスを確認する。

---

### Task 1: 判定保留（null）を最低点として描かないようにする

**Files:**
- Create: `src/components/score-overlay.ts`
- Create: `src/components/score-overlay.test.ts`
- Modify: `src/components/ScoreView.tsx:1-14`（import と `Overlay` 型）、`:16-39`（props と対応表）、`:89-97`（オーバーレイ生成）、`:119-141`（描画）

**Interfaces:**
- Consumes: なし（このタスクが最初）
- Produces:
  - `export interface MeasureScoreInput { measure: number; scoreMeasure?: number; score: number | null }`
  - `export function measureScoreKey(measureScores: readonly MeasureScoreInput[]): string`
  - `export function measureScoreMapFromKey(key: string): Map<number, number | null>`
  - `ScoreView` の props に `measureScores?: readonly MeasureScoreInput[]` を持たせる（Task 3 が実データの配列をそのまま渡せるようにする）

- [ ] **Step 1: 失敗するテストを書く**

`src/components/score-overlay.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { measureScoreKey, measureScoreMapFromKey, type MeasureScoreInput } from "./score-overlay";

/** ScoreView が useMemo 越しにやっている往復（直列化 → 対応表）をそのまま検証する。 */
function roundTrip(measureScores: MeasureScoreInput[]): Map<number, number | null> {
  return measureScoreMapFromKey(measureScoreKey(measureScores));
}

test("判定保留の小節は null のまま復元される", () => {
  // 旧実装は "2:null" を Number() に通して NaN にしていた。NaN は
  // scoreColor() の全比較を false にして最低点の赤を返すため、
  // 判定保留が「0点相当」として塗られていた（#29 と同じ性質の退行）。
  const map = roundTrip([
    { measure: 1, score: 88 },
    { measure: 2, score: null },
  ]);
  assert.equal(map.get(2), null);
  assert.equal(Number.isNaN(map.get(2) as number), false);
  // 「保留」と「このテイクの対象外」を区別するため、保留の小節もキーは持つ。
  assert.equal(map.has(2), true);
  assert.equal(map.has(3), false);
});

test("小数のスコアが往復しても値が変わらない", () => {
  const map = roundTrip([{ measure: 7, score: 62.5 }]);
  assert.equal(map.get(7), 62.5);
});

test("対応表は楽譜上の小節番号（scoreMeasure）で引ける", () => {
  const map = roundTrip([{ measure: 33, scoreMeasure: 17, score: 71 }]);
  assert.equal(map.get(17), 71);
  assert.equal(map.has(33), false);
});

test("scoreMeasure が無いデータは measure を楽譜上の小節番号として扱う", () => {
  const map = roundTrip([{ measure: 4, score: 55 }]);
  assert.equal(map.get(4), 55);
});

test("同じ楽譜上の小節に複数回の演奏が写る場合は低いスコアを残す", () => {
  const map = roundTrip([
    { measure: 1, scoreMeasure: 1, score: 90 },
    { measure: 17, scoreMeasure: 1, score: 40 },
  ]);
  assert.equal(map.get(1), 40);
});

test("判定保留と採点済みが同じ楽譜上の小節に写る場合は採点済みを残す", () => {
  const map = roundTrip([
    { measure: 1, scoreMeasure: 1, score: null },
    { measure: 17, scoreMeasure: 1, score: 55 },
  ]);
  assert.equal(map.get(1), 55);
});

test("measureScores が空なら対応表も空", () => {
  assert.equal(roundTrip([]).size, 0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx tsx --test src/components/score-overlay.test.ts`
Expected: FAIL（`Cannot find module './score-overlay'`）

- [ ] **Step 3: 純関数を実装する**

`src/components/score-overlay.ts`:

```ts
// ScoreView のヒートマップ計算のうち、DOM と OSMD に依存しない部分。
//
// このモジュールの責務は「判定保留（score: null）を 0 点や最低点として扱わないこと」。
// 旧実装は measureScores を文字列に落として Number() で戻していたため、null が NaN に
// なり、scoreColor(NaN) が最低点の赤を返していた。
//
// 小節番号は2系統ある（docs/spec/api.md:72）。`measure` は繰り返し展開後の演奏順、
// `scoreMeasure` は楽譜上の番号。OSMD が描くのは楽譜そのものなので、重ね合わせは
// scoreMeasure で引く。

export interface MeasureScoreInput {
  /** 繰り返し展開後の演奏順小節番号。 */
  measure: number;
  /** 楽譜上の小節番号。省略時は measure と同じとみなす（モックデータ）。 */
  scoreMeasure?: number;
  /** 採点結果。null は判定保留（0点ではない）。 */
  score: number | null;
}

/**
 * useMemo の依存に使える安定キー。measureScores は毎レンダー新しい配列になり得るため、
 * 内容から作った文字列を依存にする（配列そのものを依存にすると毎回 OSMD を再描画する）。
 * null は数値と衝突しない "null" として書き出す。
 */
export function measureScoreKey(measureScores: readonly MeasureScoreInput[]): string {
  return measureScores
    .map((m) => `${m.scoreMeasure ?? m.measure}:${m.score === null ? "null" : m.score}`)
    .join(",");
}

/** 採点済みが判定保留に勝ち、採点済み同士では低い方（弱い小節）を残す。 */
function mergeScores(existing: number | null, incoming: number | null): number | null {
  if (existing === null) return incoming;
  if (incoming === null) return existing;
  return Math.min(existing, incoming);
}

/**
 * measureScoreKey() の逆変換。「楽譜上の小節番号 → スコア」の対応表を返す。
 * 判定保留は null のまま復元し、キー自体は存在させる（値の無い小節＝このテイクの
 * 対象外と区別するため）。
 */
export function measureScoreMapFromKey(key: string): Map<number, number | null> {
  const map = new Map<number, number | null>();
  if (!key) return map;
  for (const entry of key.split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator < 0) continue;
    const measure = Number(entry.slice(0, separator));
    if (!Number.isFinite(measure)) continue;
    const rawScore = entry.slice(separator + 1);
    const parsed = rawScore === "null" ? null : Number(rawScore);
    // "null" 以外で数値にならない値（"NaN" 等）も保留として扱う。点数に見せない。
    const score = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    map.set(measure, map.has(measure) ? mergeScores(map.get(measure) ?? null, score) : score);
  }
  return map;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx tsx --test src/components/score-overlay.test.ts`
Expected: PASS（7 tests, 0 fail）

- [ ] **Step 5: `ScoreView` を純関数に差し替える**

`src/components/ScoreView.tsx` の先頭 import（現在の3-5行目）を差し替える:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { measureScoreKey, measureScoreMapFromKey, type MeasureScoreInput } from "@/components/score-overlay";
import { scoreColor } from "@/lib/format";
```

`Overlay` 型（7-14行目）に判定保留のフラグを足す:

```ts
interface Overlay {
  measure: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number | null;
  /** このテイクに記録はあるが採点が保留された小節。 */
  withheld: boolean;
}
```

props の型（22-28行目）で mock 型を捨てる:

```ts
}: {
  scoreUrl: string;
  measureScores?: readonly MeasureScoreInput[];
  showHeatmap?: boolean;
  onSelectMeasure?: (measure: number) => void;
  selected?: number | null;
}) {
```

対応表の作成（32-39行目）を差し替える:

```ts
  const scoreKey = measureScoreKey(measureScores);
  const scoreMap = useMemo(() => measureScoreMapFromKey(scoreKey), [scoreKey]);
```

オーバーレイ生成（74行目の `scoreMapLocal` と 89-96行目の `rects.push`）を差し替える。
`scoreMapLocal` の別名は不要なので削除し、`rects.push` を次にする:

```ts
          const score = scoreMap.get(measureNo) ?? null;
          rects.push({
            measure: measureNo,
            x,
            y: top,
            w,
            h: Math.max(10, bottom - top),
            score,
            withheld: score === null && scoreMap.has(measureNo),
          });
```

描画（119-141行目の `overlays.map`）を差し替える:

```tsx
              {overlays.map((o) => (
                <div
                  key={o.measure}
                  onClick={() => onSelectMeasure?.(o.measure)}
                  className={`pointer-events-auto absolute cursor-pointer rounded-sm transition-opacity hover:opacity-70 ${
                    selected === o.measure ? "ring-2 ring-violet-600" : ""
                  }`}
                  style={{
                    left: o.x,
                    top: o.y,
                    width: o.w,
                    height: o.h,
                    backgroundColor:
                      o.score === null ? "transparent" : `${scoreColor(o.score)}38`,
                    // 判定保留は色で点数を暗示できないため、斜線で「記録はあるが未採点」を
                    // 示す（TakeEvaluationPanel の数字グリッドの表現に合わせる）。
                    backgroundImage: o.withheld
                      ? "repeating-linear-gradient(135deg, transparent, transparent 3px, #94a3b8 3px, #94a3b8 4px)"
                      : undefined,
                    borderBottom:
                      o.score === null ? "none" : `3px solid ${scoreColor(o.score)}`,
                  }}
                  title={
                    o.score !== null
                      ? `${o.measure}小節：${o.score.toFixed(1)}点`
                      : o.withheld
                        ? `${o.measure}小節（判定保留）`
                        : `${o.measure}小節（このテイクの対象外）`
                  }
                />
              ))}
```

- [ ] **Step 6: 型チェックと Lint とテストを通す**

Run: `npx tsc --noEmit && npm run lint && npx tsx --test src/components/score-overlay.test.ts`
Expected: いずれもエラー 0。`tsc` が `ScoreView` の `measureScores` で mock 型の不一致を
出す場合は、mock 側ではなく `MeasureScoreInput` の定義を見直す（`src/lib/mock/types.ts` は
変更しない。mock の `score: number` は `number | null` に代入可能なので通るはず）。

- [ ] **Step 7: コミット**

```bash
git add src/components/score-overlay.ts src/components/score-overlay.test.ts src/components/ScoreView.tsx
git commit -m "fix: stop painting withheld measures as the lowest score"
```

---

### Task 2: `ScoreView` からモック専用の前提を外す

`ScoreView` はモック側の使い方しか想定していない箇所が2つある。

1. `:157-161` が「※ デモ用サンプル楽譜（16小節）に…」という注記をヒートマップ表示時に
   無条件で出す。モックの曲は全て `/scores/etude-in-a-minor.musicxml`（16小節）なので
   モックでは正しいが、実データで出すと嘘になる。注記を呼び出し側から渡す形にして、
   モック画面の文言は一字一句そのまま保つ。
2. `:119-135` のオーバーレイが `onSelectMeasure` の有無に関わらず `cursor-pointer` と
   `hover:opacity-70` を付ける。表示専用（Task 3）で置くと、押せないものが押せるように
   見える。ハンドラが無いときは非インタラクティブにする。

**Files:**
- Modify: `src/components/ScoreView.tsx:16-28`（props に `footnote`）、`:119-135`
  （インタラクティブ判定）、`:157-161`（注記の描画）
- Modify: `src/components/TakeAnalysisView.tsx:189-194`
- Modify: `src/components/SongDetailView.tsx:71-76`

**Interfaces:**
- Consumes: Task 1 の `ScoreView` props（`measureScores?: readonly MeasureScoreInput[]`）
- Produces: `ScoreView` の props に `footnote?: string` が増える（Task 3 は渡さない）。
  `onSelectMeasure` を渡さない呼び出しではオーバーレイがクリック不可になる。

- [ ] **Step 1: `ScoreView` に `footnote` を追加する**

props（Task 1 で書き換えた箇所）に1行足す:

```ts
export default function ScoreView({
  scoreUrl,
  measureScores = [],
  showHeatmap = true,
  onSelectMeasure,
  selected,
  footnote,
}: {
  scoreUrl: string;
  measureScores?: readonly MeasureScoreInput[];
  showHeatmap?: boolean;
  onSelectMeasure?: (measure: number) => void;
  selected?: number | null;
  /** 楽譜の下に出す注記。渡されなければ何も出さない。 */
  footnote?: string;
}) {
```

157-161行目の注記を差し替える:

```tsx
      {footnote && showHeatmap && status === "ready" && (
        <p className="mt-2 text-[11px] text-[var(--muted)]">{footnote}</p>
      )}
```

- [ ] **Step 2: ハンドラが無いときはオーバーレイをクリック不可にする**

Task 1 Step 5 で書き換えたオーバーレイの `onClick` と `className` を差し替える
（`style` と `title` は Task 1 のままで変更しない）:

```tsx
                <div
                  key={o.measure}
                  onClick={onSelectMeasure ? () => onSelectMeasure(o.measure) : undefined}
                  className={`pointer-events-auto absolute rounded-sm transition-opacity ${
                    onSelectMeasure ? "cursor-pointer hover:opacity-70" : ""
                  } ${selected === o.measure ? "ring-2 ring-violet-600" : ""}`}
```

`pointer-events-auto` は残す。親が `pointer-events-none`（117行目）なので、これを外すと
ヒットテスト対象から抜けて `title` のツールチップが出なくなり、表示専用のときにスコアの
数値を読む手段が無くなる。外すのは「押せるように見せる」部分（`cursor-pointer` と
`hover:opacity-70`）と `onClick` だけにする。

- [ ] **Step 3: モックの呼び出し側で同じ文言を渡す**

`src/components/TakeAnalysisView.tsx:189-194`:

```tsx
            <ScoreView
              scoreUrl={song.scoreUrl ?? "/scores/etude-in-a-minor.musicxml"}
              measureScores={take.measureScores}
              onSelectMeasure={(m) => setSelected(selected === m ? null : m)}
              selected={selected}
              footnote="※ デモ用サンプル楽譜（16小節）に、分析結果の小節スコアを色で重ねています。本実装ではアップロードされたMusicXMLをそのまま表示します。"
            />
```

`src/components/SongDetailView.tsx:71-76`:

```tsx
              <ScoreView
                scoreUrl={song.scoreUrl ?? "/scores/etude-in-a-minor.musicxml"}
                measureScores={latest.measureScores}
                onSelectMeasure={setSelected}
                selected={selected}
                footnote="※ デモ用サンプル楽譜（16小節）に、分析結果の小節スコアを色で重ねています。本実装ではアップロードされたMusicXMLをそのまま表示します。"
              />
```

- [ ] **Step 4: 型チェックと Lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: エラー 0

- [ ] **Step 5: モック画面が現状のままか目視する**

Run: `npm run dev`（別シェル）
- `http://localhost:3000/takes/take-cw-1` を開く。「楽譜ビュー」に楽譜が出て、小節が色で
  塗られ、下に「※ デモ用サンプル楽譜（16小節）に…」の注記が出ている。小節にカーソルを
  乗せると指カーソルになり、クリックでピアノロールが絞り込まれる（Task 1・2 で
  インタラクティブな側を壊していないことの確認）。
- `http://localhost:3000/songs/chopin-waltz-64-2` を開く。同じく楽譜・色・注記が出る。
- ブラウザのコンソールに `OSMD render failed` が出ていない。

- [ ] **Step 6: コミット**

```bash
git add src/components/ScoreView.tsx src/components/TakeAnalysisView.tsx src/components/SongDetailView.tsx
git commit -m "refactor: make the score overlay caller-driven"
```

---

### Task 3: 実データのテイク詳細に楽譜ビューを設置する

**Files:**
- Modify: `src/lib/api/client.ts:5-16`（`ApiSong`）、`:52-58`（`ApiTakeDetail.measureScores`）
- Create: `src/components/TakeScoreCard.tsx`
- Modify: `src/app/takes/real/[takeId]/page.tsx:1-9`（import）、`:78`（設置）

**Interfaces:**
- Consumes: Task 1 の `MeasureScoreInput` と `ScoreView`（`footnote` は渡さない、
  `onSelectMeasure` も渡さない）
- Produces: `TakeScoreCard`（default export）— props は
  `{ songId: string; measureScores: readonly MeasureScoreInput[] }`

- [ ] **Step 1: Next.js のガイドを読む**

Read: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
Read: `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`

確認すること: Client Component の中で `useEffect` から fetch する書き方が、この版で
非推奨になっていないか（`/takes/real/[takeId]/page.tsx` は既に `"use client"` + `useEffect`
+ `getTake()` でこの形を取っている。同じ形に揃えるのが目的）。ガイドが別の推奨形を
示している場合は、その形に合わせて Step 3 のコンポーネントを書き直す。

- [ ] **Step 2: API クライアントの型に、既に返っているフィールドを宣言する**

`src/lib/api/client.ts` の `ApiSong`（5-16行目）に2つ足す。`GET /api/songs/{songId}` は
`SongDoc` をそのまま返しているので、レスポンスには既に入っている:

```ts
export interface ApiSong {
  id: string;
  title: string;
  composer: string;
  targetTempo: number | null;
  status: "awaiting_score" | "converting_score" | "reviewing_score" | "omr_failed" | "ready";
  measureCount: number | null;
  timeSignature: string | null;
  keySignature: string | null;
  detectedTempo: number | null;
  scoreSource: "musicxml" | "midi" | "pdf" | null;
  /** OSMD で描ける MusicXML プレビューのファイル名。null なら楽譜を描けない。 */
  previewScoreFileName: string | null;
  warnings: { code: string; message: string; measures?: number[] }[];
}
```

`ApiTakeDetail.measureScores`（52-58行目）に楽譜上の小節番号を足す:

```ts
  measureScores: {
    measure: number;
    /** 楽譜上の小節番号（docs/spec/api.md:72）。繰り返しが無い曲では measure と一致する。 */
    scoreMeasure: number;
    score: number | null;
    confidence: number | null;
    metrics: Record<string, number | null>;
    metricEvaluations: Record<string, ApiMetricEvaluation>;
  }[];
```

- [ ] **Step 3: 楽譜ビューのカードを作る**

`src/components/TakeScoreCard.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui";
import ScoreView from "@/components/ScoreView";
import { getSong } from "@/lib/api/client";
import type { MeasureScoreInput } from "@/components/score-overlay";

/**
 * 実データのテイク詳細に置く楽譜ビュー。テイクの詳細レスポンスは曲の楽譜ファイル名を
 * 含まないため、曲を1件取得して楽譜 URL を決める。楽譜が無い曲や取得に失敗した場合は
 * 何も描かない（採点結果の表示を妨げないため）。
 *
 * クリックによる小節の絞り込みは持たない（表示専用）。
 */
export default function TakeScoreCard({
  songId,
  measureScores,
}: {
  songId: string;
  measureScores: readonly MeasureScoreInput[];
}) {
  const [scoreUrl, setScoreUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { song } = await getSong(songId);
        if (!cancelled && song.previewScoreFileName) {
          setScoreUrl(`/api/songs/${songId}/score/file`);
        }
      } catch {
        // 楽譜が引けないことは採点結果の表示を止める理由にならない。
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  if (!scoreUrl || measureScores.length === 0) return null;

  return (
    <Card className="mt-5">
      <CardTitle
        title="楽譜ビュー"
        subtitle="小節ごとのスコアを楽譜に重ねて表示します。斜線は判定保留の小節です。"
      />
      <div className="p-4">
        <ScoreView scoreUrl={scoreUrl} measureScores={measureScores} />
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: テイク詳細ページに設置する**

`src/app/takes/real/[takeId]/page.tsx` の import に1行足す（9行目の下）:

```ts
import TakeScoreCard from "@/components/TakeScoreCard";
```

78行目の `<TakeEvaluationPanel take={take} />` の直後に足す:

```tsx
      <TakeEvaluationPanel take={take} />

      <TakeScoreCard songId={take.songId} measureScores={take.measureScores} />
```

- [ ] **Step 5: 型チェックと Lint とビルド**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: いずれもエラー 0

- [ ] **Step 6: コミット**

```bash
git add src/lib/api/client.ts src/components/TakeScoreCard.tsx "src/app/takes/real/[takeId]/page.tsx"
git commit -m "feat: overlay measure scores on the score for real takes"
```

---

### Task 4: 修正を確認する

コード変更は無い。Task 0 で再現した事象が Task 1〜3 で解消したことを、同じテイクで確認する。

**Files:** なし（Task 0 で作った `.data/` のデータをそのまま使う）

**Interfaces:**
- Consumes: Task 0 のテイク `take_local_check`、Task 3 で設置した `TakeScoreCard`
- Produces: なし

- [ ] **Step 1: 修正後の表示を確認する**

Run: `npm run dev`
`http://localhost:3000/takes/real/take_local_check` を開いて、次を全て確認する:
- 「楽譜ビュー」カードに楽譜が描かれ、その下に既存の「小節ごとのスコア」数字グリッドが
  残っている（グリッドの表示は変わっていない）。
- 1小節目が緑系、2小節目が赤〜橙系に塗られている。
- **3小節目が赤ではなく斜線で示され、ツールチップが「3小節（判定保留）」になっている**
  （これが Issue #35 と同時に直した欠陥の確認。修正前は赤 + 「NaN点」になる）。
- 4小節目以降は塗られておらず、ツールチップが「（このテイクの対象外）」になっている。
- 小節にカーソルを乗せても指カーソルにならないが、ツールチップは出る（表示専用）。
- コンソールに `OSMD render failed` が出ていない。

- [ ] **Step 2: 楽譜が無い曲では楽譜ビューが出ないことを確認する**

`.data/songs/song_local_check.json` の `previewScoreFileName` を一時的に `null` にして
同じページを再読み込みする。「楽譜ビュー」カードが消え、5指標と数字グリッドはそのまま出る
（エラーメッセージや空のカードが出ないこと）。確認後 `"preview.musicxml"` に戻す。

- [ ] **Step 3: dev 環境で本物のデータを目視する**

デプロイ後、イシューに記載の実データで確認する:
`/takes/real/take_010b2ab1d5e94134ac21`（曲 `song_9f548aff57dd4ea3a17c`、48小節）
- 楽譜が48小節ぶん描かれ、小節スコアが重なっている。
- **小節番号がずれていない**（楽譜の1小節目に1小節目のスコアが乗っている）。ずれている場合は
  `measure` と `scoreMeasure` の対応、または OSMD の `MeasureNumber` の起点を疑う
  （`ScoreView.tsx:83`）。
- 判定保留の小節が赤で塗られていない。

- [ ] **Step 4: 結果をイシューに記録する**

確認できた内容（スクリーンショットまたは箇条書き）を Issue #35 にコメントする。
小節番号のずれが見つかった場合は、この計画を閉じずに Task 1 の対応表の引き方から見直す。

---

### Task 5: 小節クリックによる絞り込みを別 Issue として起票する

楽譜の小節をクリックして指摘事項を絞り込む操作は、`TakeEvaluationPanel`
（フックを持たない Server Component 互換のコンポーネント）を選択状態を持つ形に変える改修を
伴うため、この計画には含めない。

- [ ] **Step 1: 起票する（ユーザーの承認後）**

```bash
gh issue create --repo nomhiro/piano-ledgerlines \
  --title "実データのテイク詳細で、楽譜の小節をクリックして指摘事項を絞り込めるようにする" \
  --label enhancement \
  --body "#35 で `/takes/real/{takeId}` に楽譜ビュー（小節スコアの重ね合わせ）を配線したが、表示専用で小節を選択できない。

モックの `/takes/{id}`（`TakeAnalysisView`）は小節クリックでピアノロールと指摘事項を絞り込む。実データ側でも同じ操作ができるようにしたい。

**必要な改修**

- \`ScoreView\` は \`onSelectMeasure\` / \`selected\` を既に受け取れる（\`src/components/ScoreView.tsx:20-27\`）ので、渡すだけで小節選択そのものは動く。
- 選択状態で指摘事項を絞り込むには \`TakeEvaluationPanel\`（\`src/components/TakeEvaluationPanel.tsx\`）の指摘事項リストが選択された小節を知る必要がある。同コンポーネントはフックを持たない Server Component 互換の作りで、\`/progress\` の Server Component からも使われているため、状態を直接持たせられない。指摘事項の描画をクライアント側の別コンポーネントに切り出すか、\`selectedMeasure\` を props で受け取る形にするかを決める必要がある。
- \`onSelectMeasure\` を渡すと \`ScoreView\` のオーバーレイがクリック可能な見た目になる（#35 の対応でハンドラが無いときは非インタラクティブにしてある）。"
```

- [ ] **Step 2: 起票した Issue 番号を Issue #35 のコメントに残す**

---

## Self-Review

**1. Issue #35 の「対応方針（要決定）」4項目の消化状況**

| イシューの項目 | 対応 |
|---|---|
| 1. どのページに置くか | Global Constraints で `/takes/real/{takeId}` のみに決定。Task 3 で実装。 |
| 2. `TakeEvaluationPanel` との関係 | パネルは変更せず、外側に `TakeScoreCard` を置く（Task 3）。数字グリッドは残す。 |
| 3. 判定保留の小節の色 | Task 1。`scoreColor` に `null`/`NaN` を渡さず、斜線で表現。回帰テスト付き。 |
| 4. `scoreUrl` が `null` の曲 | Task 3 の `TakeScoreCard` が `previewScoreFileName` を見て何も描かない。 |

イシューに書かれていなかった `scoreMeasure`（楽譜上の小節番号）の扱いを Task 1 で追加している。

**2. プレースホルダ**

「適切にエラー処理する」「後で実装」に相当する記述は無い。Task 4 の dev 目視のみ人手の確認で、
確認項目を列挙してある。

**3. 型の整合**

- `MeasureScoreInput`（Task 1 で定義）を Task 2・3 が同名で参照している。
- `ScoreView` の props は Task 1 で `measureScores` / Task 2 で `footnote` を追加し、
  Task 3 は `scoreUrl` と `measureScores` のみを渡す（`footnote`・`onSelectMeasure` 無し）。
- `ApiTakeDetail.measureScores`（Task 3 で `scoreMeasure` 追加）は
  `MeasureScoreInput`（`measure` / `scoreMeasure?` / `score`）に代入可能。
- `TakeEvaluationData.measureScores`（`{ measure: number; score: number | null }[]`）は
  変更しない。
