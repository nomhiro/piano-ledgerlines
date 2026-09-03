import assert from "node:assert/strict";
import test from "node:test";
import { assertTakeTransition } from "./take-state";

test("completed take can return to queued for reanalysis", () => {
  assert.doesNotThrow(() => assertTakeTransition("completed", "queued"));
});

test("completed take cannot skip directly to an active analysis stage", () => {
  assert.throws(
    () => assertTakeTransition("completed", "scoring"),
    /invalid take status transition/,
  );
});
