import assert from "node:assert/strict";
import test from "node:test";

import {
  dailyRecordedMinutes,
  latestAndPrevious,
  recordedMinutesInLastDays,
  recordingDayStreak,
  stagnantMeasures,
  type DashboardTake,
} from "./dashboard";

/**
 * ローカル日付の成分から ISO 文字列を作る。集計はローカル日付で束ねるので
 * （`formatDate` と同じ getter を使う）、テストもローカル成分で組んで
 * 実行環境のタイムゾーンに依存しないようにする。月は 0 起点。
 */
function at(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m, d, h).toISOString();
}

function take(overrides: Partial<DashboardTake> & { recordedAt: string }): DashboardTake {
  return {
    id: "take_1",
    songId: "song_1",
    label: "テイク",
    durationSec: 0,
    measureScores: [],
    ...overrides,
  };
}

const TODAY = new Date(2026, 7, 17, 15, 0); // 2026-08-17 15:00 ローカル

test("連続録音日数は直近の録音日から数える", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 15) }),
    take({ recordedAt: at(2026, 7, 16) }),
    take({ recordedAt: at(2026, 7, 17) }),
  ];
  assert.equal(recordingDayStreak(takes, TODAY), 3);
});

test("同じ日に複数テイクあっても1日として数える", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 17, 9) }),
    take({ recordedAt: at(2026, 7, 17, 20) }),
    take({ recordedAt: at(2026, 7, 16) }),
  ];
  assert.equal(recordingDayStreak(takes, TODAY), 2);
});

test("今日まだ録音していなくても、昨日録音していれば連続は途切れない", () => {
  // 今日で 0 に落とすと、朝の時点で毎日ストリークが消えることになる。
  const takes = [take({ recordedAt: at(2026, 7, 15) }), take({ recordedAt: at(2026, 7, 16) })];
  assert.equal(recordingDayStreak(takes, TODAY), 2);
});

test("直近の録音が2日以上前なら連続は 0", () => {
  const takes = [take({ recordedAt: at(2026, 7, 14) }), take({ recordedAt: at(2026, 7, 15) })];
  assert.equal(recordingDayStreak(takes, TODAY), 0);
});

test("間が空いた分より前は数えない", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 10) }),
    take({ recordedAt: at(2026, 7, 11) }),
    take({ recordedAt: at(2026, 7, 12) }),
    // 8/13〜8/15 は録音なし
    take({ recordedAt: at(2026, 7, 16) }),
    take({ recordedAt: at(2026, 7, 17) }),
  ];
  assert.equal(recordingDayStreak(takes, TODAY), 2);
});

test("テイクが無ければ連続は 0", () => {
  assert.equal(recordingDayStreak([], TODAY), 0);
});

test("録音時間は指定日数の窓だけを合計して分に丸める", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 17), durationSec: 90 }),
    take({ recordedAt: at(2026, 7, 11), durationSec: 60 }), // 7日窓の内側（今日から6日前）
    take({ recordedAt: at(2026, 7, 10), durationSec: 600 }), // 窓の外
  ];
  assert.equal(recordedMinutesInLastDays(takes, 7, TODAY), 3); // (90+60)/60 = 2.5 → 3
});

test("録音時間の窓にテイクが無ければ 0", () => {
  assert.equal(recordedMinutesInLastDays([], 7, TODAY), 0);
});

test("日別の録音時間は録音が無い日も 0 で埋める", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 17), durationSec: 120 }),
    take({ recordedAt: at(2026, 7, 15), durationSec: 60 }),
  ];
  const rows = dailyRecordedMinutes(takes, 3, TODAY);
  assert.deepEqual(rows, [
    { date: "8/15", minutes: 1 },
    { date: "8/16", minutes: 0 },
    { date: "8/17", minutes: 2 },
  ]);
});

test("同じ日のテイクは日別集計で合算される", () => {
  const takes = [
    take({ recordedAt: at(2026, 7, 17, 9), durationSec: 60 }),
    take({ recordedAt: at(2026, 7, 17, 21), durationSec: 120 }),
  ];
  assert.deepEqual(dailyRecordedMinutes(takes, 1, TODAY), [{ date: "8/17", minutes: 3 }]);
});

test("停滞小節は初回と最新を比べ、伸びの小さい順ではなくスコアの低い順に並ぶ", () => {
  const takes = [
    take({
      id: "old",
      recordedAt: at(2026, 7, 10),
      measureScores: [
        { measure: 1, score: 50 },
        { measure: 2, score: 60 },
        { measure: 3, score: 20 },
      ],
    }),
    take({
      id: "new",
      recordedAt: at(2026, 7, 17),
      measureScores: [
        { measure: 1, score: 51 }, // delta 1 → 停滞
        { measure: 2, score: 90 }, // delta 30 → 伸びている
        { measure: 3, score: 22 }, // delta 2 → 停滞
      ],
    }),
  ];
  assert.deepEqual(stagnantMeasures(takes), [
    { measure: 3, delta: 2, score: 22 },
    { measure: 1, delta: 1, score: 51 },
  ]);
});

test("判定保留の小節は停滞判定から除外する（null を 0 点として扱わない）", () => {
  // null を 0 と見なすと「初回 0 点 → 最新 40 点」で伸びたことにも、
  // 逆に「最新が 0 点」で最悪の停滞にもなり得る。どちらも事実ではない。
  const takes = [
    take({
      id: "old",
      recordedAt: at(2026, 7, 10),
      measureScores: [
        { measure: 1, score: null },
        { measure: 2, score: 40 },
      ],
    }),
    take({
      id: "new",
      recordedAt: at(2026, 7, 17),
      measureScores: [
        { measure: 1, score: 41 },
        { measure: 2, score: null },
      ],
    }),
  ];
  assert.deepEqual(stagnantMeasures(takes), []);
});

test("テイクが1件以下なら停滞小節は出さない", () => {
  assert.deepEqual(stagnantMeasures([take({ recordedAt: at(2026, 7, 17) })]), []);
  assert.deepEqual(stagnantMeasures([]), []);
});

test("停滞判定は録音日時の順で初回と最新を選ぶ（配列の順ではない）", () => {
  const older = take({
    id: "old",
    recordedAt: at(2026, 7, 10),
    measureScores: [{ measure: 1, score: 50 }],
  });
  const newer = take({
    id: "new",
    recordedAt: at(2026, 7, 17),
    measureScores: [{ measure: 1, score: 51 }],
  });
  assert.deepEqual(stagnantMeasures([newer, older]), [{ measure: 1, delta: 1, score: 51 }]);
});

test("最新と前回は録音日時の順で選ぶ", () => {
  const a = take({ id: "a", recordedAt: at(2026, 7, 10) });
  const b = take({ id: "b", recordedAt: at(2026, 7, 15) });
  const c = take({ id: "c", recordedAt: at(2026, 7, 17) });
  const { latest, previous } = latestAndPrevious([b, c, a]);
  assert.equal(latest?.id, "c");
  assert.equal(previous?.id, "b");
});

test("テイクが1件なら前回は無い、0件なら最新も無い", () => {
  const only = take({ id: "only", recordedAt: at(2026, 7, 17) });
  assert.deepEqual(latestAndPrevious([only]), { latest: only, previous: null });
  assert.deepEqual(latestAndPrevious([]), { latest: null, previous: null });
});
