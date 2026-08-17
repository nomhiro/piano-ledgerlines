import assert from "node:assert/strict";
import test from "node:test";

import { guidanceForNoSongs, guidanceForNoTakes } from "./empty-takes";
import type { SongDocStatus } from "@/lib/server/types";

test("a ready song offers recording with itself preselected", () => {
  assert.deepStrictEqual(guidanceForNoTakes({ id: "song_abc", status: "ready" }), {
    message: "この曲にはまだ録音がありません。",
    actionLabel: "録音する",
    actionHref: "/record?song=song_abc",
  });
});

test("a song whose score is still being parsed sends the user to the song instead", () => {
  assert.deepStrictEqual(guidanceForNoTakes({ id: "song_abc", status: "parsing_score" }), {
    message: "楽譜の準備が終わっていないため、まだ録音できません。",
    actionLabel: "曲の詳細を開く",
    actionHref: "/songs/song_abc",
  });
});

// 録音できるのは ready の曲だけ（/record は ready 以外を選べず、テイク作成 API も
// ready を要求する）。ready 以外のどの状態でも録音への導線を出してはいけない。
const NOT_RECORDABLE: SongDocStatus[] = [
  "awaiting_score",
  "parsing_score",
  "converting_score",
  "reviewing_score",
  "omr_failed",
];

for (const status of NOT_RECORDABLE) {
  test(`${status} never offers recording`, () => {
    const guidance = guidanceForNoTakes({ id: "song_abc", status });
    assert.equal(guidance.actionHref, "/songs/song_abc");
    assert.notEqual(guidance.actionLabel, "録音する");
  });
}

test("a catalog song with no registration status is treated as recordable", () => {
  // src/lib/mock のデモ曲は SongDoc を持たない。あちらの `status` は練習状況
  // (reading/practicing/...) で登録状態ではないため、ここへは渡さない。
  const guidance = guidanceForNoTakes({ id: "chopin-waltz-64-2" });
  assert.equal(guidance.actionHref, "/record?song=chopin-waltz-64-2");
});

test("an explicitly null status is treated as recordable too", () => {
  const guidance = guidanceForNoTakes({ id: "chopin-waltz-64-2", status: null });
  assert.equal(guidance.actionHref, "/record?song=chopin-waltz-64-2");
});

test("having no songs at all points at registering one", () => {
  assert.deepStrictEqual(guidanceForNoSongs(), {
    message: "まだ曲がありません。",
    actionLabel: "曲を追加する",
    actionHref: "/songs/new",
  });
});
