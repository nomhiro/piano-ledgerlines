import assert from "node:assert/strict";
import test from "node:test";

import { sortByRecordedAt } from "./real-history";

test("sortByRecordedAt orders takes from oldest to newest", () => {
  const items = [
    { id: "take-latest", recordedAt: "2026-07-24T21:36:00+09:00" },
    { id: "take-earliest", recordedAt: "2026-06-28T21:10:00+09:00" },
    { id: "take-middle", recordedAt: "2026-07-18T22:02:00+09:00" },
  ];

  assert.deepStrictEqual(
    sortByRecordedAt(items).map((item) => item.id),
    ["take-earliest", "take-middle", "take-latest"],
  );
});
