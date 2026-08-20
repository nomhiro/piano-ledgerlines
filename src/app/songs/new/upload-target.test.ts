import assert from "node:assert/strict";
import test from "node:test";

import { shouldCreateSong, uploadTitle } from "./upload-target";

test("曲がまだ無いときは作る", () => {
  assert.equal(shouldCreateSong(null), true);
});

test("失敗後の再投入では曲を作り直さない", () => {
  // 作り直すと、楽譜の無い曲がライブラリに溜まる（#48）。
  assert.equal(shouldCreateSong("song_abc"), false);
});

test("ユーザーが曲名を入力していればそれを使う", () => {
  assert.equal(
    uploadTitle({ titleTouched: true, title: "ワルツ 第7番", fileName: "waltz7.musicxml" }),
    "ワルツ 第7番",
  );
});

test("入力が無ければファイル名から拡張子を落として使う", () => {
  assert.equal(
    uploadTitle({ titleTouched: false, title: "", fileName: "summer.musicxml" }),
    "summer",
  );
});

test("ユーザーが触っていない曲名は、再投入したファイル名で置き換わる", () => {
  // ここが #48 の修正で退行しやすい点。曲を再利用するため、最初の（壊れた）
  // ファイル名が曲名として残り続けないようにする。title には前回の導出値が
  // 入っているが、touched でなければ無視する。
  assert.equal(
    uploadTitle({ titleTouched: false, title: "broken", fileName: "summer.musicxml" }),
    "summer",
  );
});

test("ユーザーが触った曲名は、再投入でも上書きしない", () => {
  assert.equal(
    uploadTitle({ titleTouched: true, title: "自分でつけた名前", fileName: "summer.musicxml" }),
    "自分でつけた名前",
  );
});

test("touched でも空文字ならファイル名に落ちる", () => {
  // 入力欄を空にして投入した場合。空の曲名を作らない。
  assert.equal(uploadTitle({ titleTouched: true, title: "", fileName: "summer.mid" }), "summer");
  assert.equal(uploadTitle({ titleTouched: true, title: "   ", fileName: "summer.mid" }), "summer");
});

test("対応する拡張子をすべて落とす（大文字も）", () => {
  const cases: [string, string][] = [
    ["a.musicxml", "a"],
    ["a.xml", "a"],
    ["a.mxl", "a"],
    ["a.mid", "a"],
    ["a.midi", "a"],
    ["a.pdf", "a"],
    ["a.MusicXML", "a"],
    ["a.PDF", "a"],
  ];
  for (const [fileName, expected] of cases) {
    assert.equal(uploadTitle({ titleTouched: false, title: "", fileName }), expected, fileName);
  }
});

test("ファイル名の途中のドットは残す", () => {
  assert.equal(
    uploadTitle({ titleTouched: false, title: "", fileName: "op.9 no.2.musicxml" }),
    "op.9 no.2",
  );
});

test("知らない拡張子は落とさない", () => {
  // 受け付けない拡張子はサーバが弾く。ここで勝手に削ると、何を送ったのか
  // 分からない曲名になる。
  assert.equal(uploadTitle({ titleTouched: false, title: "", fileName: "score.txt" }), "score.txt");
});

test("拡張子だけのファイル名でも空の曲名にしない", () => {
  assert.equal(uploadTitle({ titleTouched: false, title: "", fileName: ".musicxml" }), ".musicxml");
});
