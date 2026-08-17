// ダッシュボード（`/`）が実データから出す集計（#38）。
//
// I/O を持たず `today` を引数で受ける純粋関数にしてある。理由は2つ:
// 集計の境界（連続日数の途切れ、窓の端、判定保留の小節）をネットワークも
// 現在時刻も介さずテストで固定できること、そして日付の扱いを1箇所に閉じること。

/**
 * 集計が読むフィールドをすべて備えた形。`TakeDoc` はこれを満たすので、
 * 呼び出し側は変換せずそのまま渡せる。
 *
 * 各関数の引数は「その関数が実際に読むフィールド」だけを要求し、返す型も
 * 呼び出し側の型を保つ（総称型）。ここで `DashboardTake` に狭めてしまうと、
 * `overallScore` や `evaluation` のような集計に不要なフィールドが呼び出し側で
 * 失われる。
 */
export interface DashboardTake {
  id: string;
  songId: string;
  label: string;
  recordedAt: string;
  durationSec: number;
  measureScores: readonly { measure: number; score: number | null }[];
}

type RecordedAt = { recordedAt: string };
type Recorded = RecordedAt & { durationSec: number };
type Scored = RecordedAt & {
  measureScores: readonly { measure: number; score: number | null }[];
};

/**
 * ローカル日付のキー。`formatDate` / `formatDateTime`（`src/lib/format.ts`）が
 * ローカルの getter で表示しているので、集計もローカル日付で束ねて表示と揃える。
 */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function byRecordedAt(a: RecordedAt, b: RecordedAt): number {
  return new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime();
}

/**
 * 録音した日が何日連続しているか。
 *
 * 直近の録音日が今日でも昨日でもなければ 0 を返す（連続は途切れている）。
 * 「今日録音していなければ 0」にはしない——それだと毎朝ストリークが消える。
 */
export function recordingDayStreak(takes: readonly RecordedAt[], today: Date): number {
  if (takes.length === 0) return 0;
  const days = new Set(takes.map((take) => dayKey(new Date(take.recordedAt))));
  const todayStart = startOfDay(today);

  // 今日か昨日のどちらから数え始めるかを決める。どちらにも無ければ途切れている。
  let cursor: Date | null = null;
  if (days.has(dayKey(todayStart))) cursor = todayStart;
  else if (days.has(dayKey(addDays(todayStart, -1)))) cursor = addDays(todayStart, -1);
  if (!cursor) return 0;

  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 直近 `days` 日（今日を含む）の録音時間の合計。分に丸める。 */
export function recordedMinutesInLastDays(
  takes: readonly Recorded[],
  days: number,
  today: Date,
): number {
  const from = addDays(startOfDay(today), -(days - 1)).getTime();
  const totalSec = takes
    .filter((take) => startOfDay(new Date(take.recordedAt)).getTime() >= from)
    .reduce((sum, take) => sum + take.durationSec, 0);
  return Math.round(totalSec / 60);
}

/**
 * 直近 `days` 日の録音時間を日別に。古い順で、録音が無い日も 0 で埋める
 * （埋めないと棒グラフの横軸が詰まって、空いた日が見えなくなる）。
 */
export function dailyRecordedMinutes(
  takes: readonly Recorded[],
  days: number,
  today: Date,
): { date: string; minutes: number }[] {
  const secByDay = new Map<string, number>();
  for (const take of takes) {
    const key = dayKey(new Date(take.recordedAt));
    secByDay.set(key, (secByDay.get(key) ?? 0) + take.durationSec);
  }
  const todayStart = startOfDay(today);
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(todayStart, -(days - 1 - index));
    return {
      date: `${date.getMonth() + 1}/${date.getDate()}`,
      minutes: Math.round((secByDay.get(dayKey(date)) ?? 0) / 60),
    };
  });
}

/**
 * 1曲のテイク列から、初回テイクと比べて伸びていない小節を返す。
 * モックの `findStagnantMeasures`（`src/lib/mock/data.ts:535`）と同じ定義
 * （`delta < threshold`、スコアの低い順）。
 *
 * **どちらかのテイクでスコアが `null`（判定保留）の小節は除外する。** `null` を
 * 0 点として扱うと、保留が「最悪の停滞」や「大きな伸び」に化ける（#29 / #35 で
 * 踏んだのと同じ罠）。
 */
export function stagnantMeasures(
  takes: readonly Scored[],
  threshold = 3,
): { measure: number; delta: number; score: number }[] {
  if (takes.length < 2) return [];
  const ordered = [...takes].sort(byRecordedAt);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  const firstScores = new Map<number, number>();
  for (const measure of first.measureScores) {
    if (measure.score !== null) firstScores.set(measure.measure, measure.score);
  }

  return last.measureScores
    .flatMap((measure) => {
      if (measure.score === null) return [];
      const before = firstScores.get(measure.measure);
      if (before === undefined) return [];
      return [
        {
          measure: measure.measure,
          delta: Math.round((measure.score - before) * 10) / 10,
          score: measure.score,
        },
      ];
    })
    .filter((measure) => measure.delta < threshold)
    .sort((a, b) => a.score - b.score);
}

/** 録音日時の順で最新テイクと1つ前のテイクを返す（配列の順には依存しない）。 */
export function latestAndPrevious<T extends RecordedAt>(takes: readonly T[]): {
  latest: T | null;
  previous: T | null;
} {
  const ordered = [...takes].sort(byRecordedAt);
  return {
    latest: ordered[ordered.length - 1] ?? null,
    previous: ordered.length > 1 ? ordered[ordered.length - 2] : null,
  };
}
