# pitch の extra 分類と τ 再校正（段3）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pitch の指標式を検証可能な形にし、`overallScore` が数値で表示される状態へ戻す（Issue #40）。

**Architecture:** `extra`（マッチしなかった採譜音符）を採譜アーティファクト `extraNoise` と実際の弾き間違い `extraPlayed` に分類し、`e_pitch` は後者だけを計上する。そのうえで `TAU_PITCH` と `W_EXTRA` を、MAESTRO MIDI の既知の摂動に対する応答（弁別力）と、実録音1件の採譜結果（アーティファクト実在性）から決める。分類ロジックは worker に1つだけ置き、検証ハーネス（`poc/scripts/`）はそれを import して本番コードそのものを測る。

**Tech Stack:** Python 3.11 + numpy + pretty_midi（worker / poc 共通）/ unittest / MAESTRO v3.0.0 MIDI zip / Docker Compose（ワーカーコンテナ、採譜モデル同梱）

**Spec:** `docs/superpowers/specs/2026-08-15-restore-performance-scores-design.md` — §4.2 / §4.3 / §5.1 / §5.2、および段3 着手時の修正 **§9**（§9 が 4〜8章と衝突する場合は §9 が優先）

## Global Constraints

- ワーカーのテストは `cd worker && python tests/test_<name>.py`（既存の unittest 形式。pytest は使わない）。テスト出力は pristine に保つ
- **librosa をどこにも追加しない。** ホストにもワーカーイメージにも入っておらず、§9.2 はそれを前提に MIDI 由来の等間隔グリッドを採る
- **分類ロジックを複製しない。** §9.1 のとおり実体は `worker/ledgerlines_worker/` の1箇所で、`poc/scripts/` はそれを import する
- 分類の閾値は**フェーズ2 まで暫定**（設計 §4.2 / §8）。コード内にその旨をコメントで明示する: `NOISE_ONSET_SEC = 0.050` / `NOISE_SPURIOUS_DURATION_SEC = 0.060` / `NOISE_SPURIOUS_VELOCITY = 40` / `NOISE_VELOCITY_RATIO = 0.50`
- 拍グリッドの分割数は **16**（§9.2。実測で8分割ではトリルが同一格子に潰れた）
- MAESTRO MIDI zip は **`poc/data/maestro-midi.zip` に取得済み**（55.7MB、v3.0.0、`poc/.gitignore` 済み）。再ダウンロード不要
- **τ の根拠は教師較正ではない**（設計 §4.3 / §9.4）。段3 完了の意味は「`overallScore` が数値になる」ことだけであり、「その点数が音楽的に妥当と証明された」ことではない。ドキュメントにそう書く
- **フェーズ1 が通らない限りフェーズ2 に進まない**（設計 §5.1）。フェーズ2（MAESTRO 音声・録音条件不変性）は本計画のスコープ外
- スコアやメタデータを捏造しない。測れていない値を採点の証跡として書かない

---

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `worker/tests/test_extra_classification.py` | `classify_extra` の単体テスト（4規則＋境界） |
| `poc/scripts/sweep_pitch_tau.py` | `(TAU_PITCH, W_EXTRA)` の候補格子を掃引し、フェーズ1 の合格条件4項目を判定する |
| `poc/scripts/measure_real_take.py` | 脚2。実録音の採譜結果に対する extra 分類の内訳と τ 応答を測る |
| `docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md` | 測定結果の記録（フェーズ1 の表、脚2 の表、確定した τ / W_EXTRA とその理由） |

**変更**

| ファイル | 変更内容 |
|---|---|
| `worker/ledgerlines_worker/align.py` | `classify_extra()` と閾値定数を追加。`align()` が `est_pedal` を受け取り `extraNoise` / `extraPlayed` / `extraNoiseByReason` を返す |
| `worker/ledgerlines_worker/metrics.py` | `e_pitch` が `extraPlayed` を使う。`TAU_PITCH` / `W_EXTRA` を確定値へ |
| `worker/ledgerlines_worker/confidence.py` | diagnostics に分類内訳。`decide()` の pitch 固定保留を削除 |
| `worker/worker_main.py` | MIDI の読み込みを1回にし、`est_pedal` を `align()` へ渡す |
| `worker/tests/test_confidence.py` | pitch が `scored` になり `overallScore` が数値になることへ期待値を更新 |
| `worker/tests/fixtures/issue8_take_diagnostic.json` | 分類内訳のキーを追加（τ 確定後に回帰値を固定） |
| `poc/scripts/align.py` | worker の `align` / `load_est` を import する CLI へ（アルゴリズム本体を削除） |
| `poc/scripts/compute_metrics.py` | worker の `metrics.compute` / `load_est` / `pedal_intervals` を import する CLI へ |
| `poc/scripts/prepare_dataset.py` | `--midi-only`（音声を使わず MIDI zip だけでデータセットを組む） |
| `poc/scripts/make_reference.py` | `--midi-only`（MIDI 由来の等間隔グリッド、16分割、`pedalIntervalsBeats` を出力） |
| `poc/README.md` | 段3 の実行手順 |
| `docs/spec/metrics.md` | 3.1 pitch — extra の分類、確定した `W_EXTRA` / `TAU_PITCH`、根拠が摂動応答と実録音であること、教師較正は未であること |

---

## Task 1: extra 分類の純ロジック

**Files:**
- Modify: `worker/ledgerlines_worker/align.py`（末尾に追加。既存の `align()` はこのタスクでは触らない）
- Test: `worker/tests/test_extra_classification.py`（新規）

**Interfaces:**
- Consumes: `est_notes` の要素は `{"index": int, "pitch": int, "start": float, "end": float, "velocity": int}`（`align.load_est` が返す形、`align.py:281-289`）
- Produces:
  - `classify_extra(est_notes, pairs, extra, est_pedal=None) -> dict` — `{"extraNoise": list[int], "extraPlayed": list[int], "extraNoiseByReason": {"duplicate": int, "harmonic": int, "spurious": int, "reverb": int}}`。`pairs` は `align()` が返す `(ref_index, est_index)` の列、`extra` は est index の列、`est_pedal` は `[(開始秒, 終了秒), ...]`
  - 定数 `NOISE_ONSET_SEC = 0.050` / `NOISE_SPURIOUS_DURATION_SEC = 0.060` / `NOISE_SPURIOUS_VELOCITY = 40` / `NOISE_VELOCITY_RATIO = 0.50`

**背景（実装者向け）**

設計 §4.2 の4規則を実装する。**判定の優先順は設計の並び（1→2→3→4）に従うこと。** 内訳は監査用なので、複数の規則に該当する音符にどの理由が付くかが設計の記述と一致していなければならない。

1. `duplicate` — マッチ済み音符と同一ピッチで onset 差が 50 ms 以内（二重検出）
2. `harmonic` — マッチ済み音符の ±12 半音で onset 差が 50 ms 以内、かつ velocity がその音符の 50% 未満（倍音ゴースト）
3. `spurious` — duration が 60 ms 未満かつ velocity が 40 未満
4. `reverb` — 採譜側のペダル区間内にあり、同一ペダル区間内でそれより前にマッチした同ピッチ音符があり、velocity がその音符の 50% 未満（残響）

`extraPlayed` は上記に該当しないもの。**実際の弾き間違いはここに残らなければならない**（フェーズ1 の合格条件3がこれを検証する）。

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_extra_classification.py`

```python
from __future__ import annotations

import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.align import (  # noqa: E402
    NOISE_ONSET_SEC,
    NOISE_SPURIOUS_DURATION_SEC,
    NOISE_SPURIOUS_VELOCITY,
    NOISE_VELOCITY_RATIO,
    classify_extra,
)


def note(index: int, pitch: int, start: float, velocity: int = 80, duration: float = 0.5) -> dict:
    return {
        "index": index,
        "pitch": pitch,
        "start": start,
        "end": start + duration,
        "velocity": velocity,
    }


class ClassifyExtraTest(unittest.TestCase):
    def test_same_pitch_at_the_same_onset_is_a_duplicate_detection(self):
        est = [note(0, 60, 1.000), note(1, 60, 1.020)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraPlayed"], [])
        self.assertEqual(result["extraNoiseByReason"]["duplicate"], 1)

    def test_same_pitch_far_apart_is_a_played_note(self):
        # 同一ピッチでも onset が離れていれば「同じ音をもう一度弾いた」＝弾き間違い。
        est = [note(0, 60, 1.000), note(1, 60, 1.000 + NOISE_ONSET_SEC + 0.001)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])
        self.assertEqual(result["extraNoise"], [])

    def test_weak_octave_at_the_same_onset_is_a_harmonic_ghost(self):
        est = [note(0, 60, 1.000, velocity=80), note(1, 72, 1.010, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["harmonic"], 1)

    def test_loud_octave_at_the_same_onset_is_a_played_note(self):
        # 強い八度は演奏として弾かれたもの。velocity 比だけがゴーストとの境目。
        loud = int(80 * NOISE_VELOCITY_RATIO) + 5
        est = [note(0, 60, 1.000, velocity=80), note(1, 72, 1.010, velocity=loud)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])

    def test_short_and_weak_note_is_spurious(self):
        est = [
            note(0, 60, 1.000),
            note(1, 67, 5.000, velocity=NOISE_SPURIOUS_VELOCITY - 1,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["spurious"], 1)

    def test_short_but_loud_note_is_a_played_note(self):
        est = [
            note(0, 60, 1.000),
            note(1, 67, 5.000, velocity=NOISE_SPURIOUS_VELOCITY,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])

    def test_weak_repeat_inside_a_pedal_span_is_reverb(self):
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 2.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 3.0)])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["reverb"], 1)

    def test_weak_repeat_outside_any_pedal_span_is_a_played_note(self):
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 2.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 1.5)])
        self.assertEqual(result["extraPlayed"], [1])

    def test_weak_repeat_in_a_different_pedal_span_is_a_played_note(self):
        # 別のペダル区間の音は残響では説明できない（ペダルが上がって減衰している）。
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 4.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 1.5), (3.5, 5.0)])
        self.assertEqual(result["extraPlayed"], [1])

    def test_a_wrong_note_survives_as_played(self):
        # 隣接半音の誤打（フェーズ1 の合格条件3が守るもの）。
        est = [note(0, 60, 1.000), note(1, 61, 1.000)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])
        self.assertEqual(sum(result["extraNoiseByReason"].values()), 0)

    def test_reason_priority_follows_the_design_order(self):
        # 同一ピッチ・同時・短く弱い音は、設計の並び（1→2→3→4）により duplicate。
        est = [
            note(0, 60, 1.000, velocity=90),
            note(1, 60, 1.010, velocity=NOISE_SPURIOUS_VELOCITY - 1,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoiseByReason"]["duplicate"], 1)
        self.assertEqual(result["extraNoiseByReason"]["spurious"], 0)

    def test_no_extra_returns_empty_buckets(self):
        est = [note(0, 60, 1.000)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[])
        self.assertEqual(result["extraNoise"], [])
        self.assertEqual(result["extraPlayed"], [])
        self.assertEqual(sum(result["extraNoiseByReason"].values()), 0)

    def test_unmatched_reference_only_notes_do_not_crash(self):
        # pairs に est 側に存在しない index が入っていても落ちない（防御）。
        est = [note(0, 60, 1.000)]
        result = classify_extra(est, pairs=[(0, 0), (1, 99)], extra=[])
        self.assertEqual(result["extraPlayed"], [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 失敗することを確認する**

Run: `cd worker && python tests/test_extra_classification.py`
Expected: FAIL — `ImportError: cannot import name 'NOISE_ONSET_SEC' from 'ledgerlines_worker.align'`

- [ ] **Step 3: 実装する**

`worker/ledgerlines_worker/align.py` の末尾（`load_est` の後）に追加する。ファイル先頭の import に `bisect` が既にあることを確認すること（`_match_path` が使っている）。

```python
# 設計 4.2 の分類閾値。**フェーズ2 で MAESTRO の clean と room の extra 特徴分布から
# 確定するまでの暫定値である**（設計 4.2 / 8章 / 9.3）。実測根拠はまだ無い。
NOISE_ONSET_SEC = 0.050          # 二重検出・倍音ゴーストと見なす onset 差
NOISE_SPURIOUS_DURATION_SEC = 0.060
NOISE_SPURIOUS_VELOCITY = 40
NOISE_VELOCITY_RATIO = 0.50      # 元の音符に対する velocity 比


def _pedal_span(pedal: list[tuple[float, float]], t: float) -> tuple[float, float] | None:
    """時刻 t を含むペダル区間を返す。無ければ None。"""
    for start, end in pedal:
        if start <= t <= end:
            return (start, end)
    return None


def _noise_reason(
    note: dict,
    matched: list[dict],
    matched_starts: list[float],
    pedal: list[tuple[float, float]],
) -> str | None:
    """採譜アーティファクトと見なせる理由を返す。演奏由来なら None。

    判定順は設計 4.2 の並び（1 duplicate → 2 harmonic → 3 spurious → 4 reverb）。
    内訳は監査用なので、複数該当時にどの理由が付くかが設計と一致している必要がある。
    """
    lo = bisect.bisect_left(matched_starts, note["start"] - NOISE_ONSET_SEC)
    hi = bisect.bisect_right(matched_starts, note["start"] + NOISE_ONSET_SEC)
    near = matched[lo:hi]

    for m in near:
        if m["pitch"] == note["pitch"]:
            return "duplicate"
    for m in near:
        if (
            abs(m["pitch"] - note["pitch"]) == 12
            and note["velocity"] < m["velocity"] * NOISE_VELOCITY_RATIO
        ):
            return "harmonic"

    if (
        (note["end"] - note["start"]) < NOISE_SPURIOUS_DURATION_SEC
        and note["velocity"] < NOISE_SPURIOUS_VELOCITY
    ):
        return "spurious"

    span = _pedal_span(pedal, note["start"])
    if span is not None:
        span_start, _ = span
        for m in matched:
            if m["start"] >= note["start"]:
                break
            if m["start"] < span_start:
                continue
            if (
                m["pitch"] == note["pitch"]
                and note["velocity"] < m["velocity"] * NOISE_VELOCITY_RATIO
            ):
                return "reverb"
    return None


def classify_extra(
    est_notes: list[dict],
    pairs: list[tuple[int, int]],
    extra: list[int],
    est_pedal: list[tuple[float, float]] | None = None,
) -> dict:
    """extra を採譜アーティファクト（extraNoise）と弾き間違い（extraPlayed）に分ける。

    設計 4.2。判定1と2はマッチ済み音符を参照するため、align() が final を確定した
    後に呼ぶ必要がある。extraPlayed に実際の弾き間違いが残ることが要件で、
    フェーズ1 の合格条件3（設計 5.1）がそれを検証する。
    """
    by_index = {int(n["index"]): n for n in est_notes}
    matched = sorted(
        (by_index[int(e)] for _, e in pairs if int(e) in by_index),
        key=lambda n: n["start"],
    )
    matched_starts = [n["start"] for n in matched]
    pedal = sorted(est_pedal or [])

    noise: list[int] = []
    played: list[int] = []
    reasons = {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}

    for e_idx in extra:
        note = by_index.get(int(e_idx))
        if note is None:
            # 索引が引けない extra は分類できない。誤って noise に入れると
            # 弾き間違いを見逃すので played 側に残す。
            played.append(int(e_idx))
            continue
        reason = _noise_reason(note, matched, matched_starts, pedal)
        if reason is None:
            played.append(int(e_idx))
        else:
            noise.append(int(e_idx))
            reasons[reason] += 1

    return {
        "extraNoise": sorted(noise),
        "extraPlayed": sorted(played),
        "extraNoiseByReason": reasons,
    }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd worker && python tests/test_extra_classification.py`
Expected: PASS（13テスト、`OK`、警告なし）

- [ ] **Step 5: コミット**

```bash
git add worker/ledgerlines_worker/align.py worker/tests/test_extra_classification.py
git commit -m "feat: classify extra notes as transcription noise or played mistakes"
```

---

## Task 2: `align()` への配線と worker_main の受け渡し

**Files:**
- Modify: `worker/ledgerlines_worker/align.py:220-273`（`align()`）
- Modify: `worker/worker_main.py:301-333`
- Test: `worker/tests/test_extra_classification.py`（`align()` 経由のテストを追記）

**Interfaces:**
- Consumes: `classify_extra`（Task 1）
- Produces: `align(reference, est_notes, window_sec=1.0, mode="jump", jump_penalty=JUMP_PENALTY, est_pedal=None)` が返す dict に `extraNoise` / `extraPlayed` / `extraNoiseByReason` が加わる。既存キー（`pairs` / `missed` / `unplayed` / `retakes` / `extra` / `takes`）は**そのまま残す**（`extra` は監査用に全件を保持）

**注意:** `worker_main.py:302` は `align_mod.load_est` で音符だけを読み、`:308` で `metrics_mod.load_est` が同じ MIDI を再度読んで `(音符, ペダル)` を返している。両者の音符 dict は同一構造（`align.py:281-289` と `metrics.py:270-286` を比較して確認済み）。`align()` にペダルを渡すため、**読み込みを `metrics_mod.load_est` の1回にまとめる**。

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_extra_classification.py` に追記する（既存の import に `align` を追加）。

```python
class AlignIntegrationTest(unittest.TestCase):
    def _reference(self) -> dict:
        return {
            "notes": [
                {"index": 0, "pitch": 60, "measure": 1, "startBeat": 0.0, "endBeat": 1.0},
                {"index": 1, "pitch": 62, "measure": 1, "startBeat": 1.0, "endBeat": 2.0},
            ],
            "beatsPerMeasure": 4.0,
        }

    def test_align_splits_extra_into_noise_and_played(self):
        # 0/1 は参照譜に対応し、2 は二重検出（同一ピッチ・同時）、3 は誤打。
        est = [
            note(0, 60, 0.000),
            note(1, 62, 1.000),
            note(2, 60, 0.015),
            note(3, 61, 2.500),
        ]
        result = align(self._reference(), est)
        self.assertEqual(sorted(result["extra"]), [2, 3])
        self.assertEqual(result["extraNoise"], [2])
        self.assertEqual(result["extraPlayed"], [3])
        self.assertEqual(result["extraNoiseByReason"]["duplicate"], 1)

    def test_align_uses_pedal_for_reverb_classification(self):
        est = [
            note(0, 60, 0.000, velocity=90),
            note(1, 62, 1.000),
            note(2, 60, 0.600, velocity=20),
        ]
        without = align(self._reference(), est)
        with_pedal = align(self._reference(), est, est_pedal=[(0.0, 2.0)])
        self.assertEqual(without["extraPlayed"], [2])
        self.assertEqual(with_pedal["extraNoise"], [2])
        self.assertEqual(with_pedal["extraNoiseByReason"]["reverb"], 1)

    def test_empty_events_still_return_the_new_keys(self):
        result = align({"notes": [], "beatsPerMeasure": 4.0}, [])
        self.assertEqual(result["extraNoise"], [])
        self.assertEqual(result["extraPlayed"], [])
        self.assertEqual(sum(result["extraNoiseByReason"].values()), 0)
```

- [ ] **Step 2: 失敗することを確認する**

Run: `cd worker && python tests/test_extra_classification.py`
Expected: FAIL — `KeyError: 'extraNoise'`

- [ ] **Step 3: `align()` を実装する**

`align()` のシグネチャに `est_pedal` を足す。

```python
def align(
    reference: dict,
    est_notes: list[dict],
    window_sec: float = 1.0,
    mode: str = "jump",
    jump_penalty: float = JUMP_PENALTY,
    est_pedal: list[tuple[float, float]] | None = None,
) -> dict:
```

早期 return（音符やイベントが無い場合、現在の `:230-237`）を次にする。

```python
    if not ref_ev or not est_ev:
        return {
            "pairs": [],
            "missed": [n["index"] for n in ref_notes],
            "extra": [],
            "extraNoise": [],
            "extraPlayed": [],
            "extraNoiseByReason": {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0},
            "retakes": [],
            "unplayed": [],
        }
```

末尾の return（現在の `:260-273`）を次にする。`extra` の算出式は変えない。

```python
    pairs = sorted(final.items())
    extra = [
        n["index"]
        for n in est_notes
        if n["index"] not in matched_est and n["index"] not in retake_est
    ]
    # extra は監査用に全件を残し、採点は extraPlayed だけを使う（設計 4.2）。
    classified = classify_extra(est_notes, pairs, extra, est_pedal)
    return {
        "pairs": pairs,
        "missed": [
            n["index"] for n in ref_notes if n["index"] not in final and n["index"] in covered_notes
        ],
        "unplayed": [n["index"] for n in ref_notes if n["index"] not in covered_notes],
        "retakes": sorted(retakes),
        "extra": extra,
        **classified,
        "takes": len(runs),
    }
```

- [ ] **Step 4: worker_main の読み込みを1回にする**

`worker/worker_main.py` の `:301-308` を次にする（`est_notes_full` は `est_notes` と同一なので変数を1つにする）。

```python
        reference = read_json(data_dir / "derived" / song_id / "reference.json")
        # MIDI は1回だけ読む。metrics 側の load_est が (音符, ペダル区間) を返し、
        # 音符の dict 構造は align 側の load_est と同一。ペダルは extra 分類の
        # 判定4（残響）に必要なので align() にも渡す（設計 4.2）。
        est_notes, est_pedal = metrics_mod.load_est(midi_path)
        alignment = align_mod.align(reference, est_notes, mode="jump", est_pedal=est_pedal)
        write_json(data_dir / "derived-takes" / take_id / "alignment.json", alignment)

        update({"status": "scoring", "progress": 0.8})

        dynamic_range_db = pre.get("dynamicRangeDb")
```

`:326-333` の `metrics_mod.compute(...)` の第2引数を `est_notes_full` から `est_notes` に変える。`align_mod.load_est` の呼び出しは無くなるが、**`align_mod` の import は残す**（`align_mod.align` を使い続ける）。

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd worker && python tests/test_extra_classification.py`
Expected: PASS（16テスト）

Run: `cd worker && python tests/test_worker_main.py`
Expected: PASS（9テスト。`load_est` の呼び出し方を変えたので、ここが壊れていないことが重要）

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS（9テスト。まだ pitch は保留のまま）

- [ ] **Step 6: コミット**

```bash
git add worker/ledgerlines_worker/align.py worker/worker_main.py worker/tests/test_extra_classification.py
git commit -m "feat: feed pedal into alignment and return the extra split"
```

---

## Task 3: 採点と診断への反映

**Files:**
- Modify: `worker/ledgerlines_worker/metrics.py:131-137`
- Modify: `worker/ledgerlines_worker/confidence.py:85-95`（`alignment_evidence` の `overall`）
- Test: `worker/tests/test_metrics.py`（追記）

**Interfaces:**
- Consumes: `alignment["extraPlayed"]` / `alignment["extraNoise"]` / `alignment["extraNoiseByReason"]`（Task 2）
- Produces: `metrics.compute()` の `e_pitch` が `extraPlayed` を計上する。diagnostics に `extraPlayedNotes` / `extraNoiseNotes` / `extraNoiseByReason` が入る

**注意:** 古い `alignment.json`（分類キーが無い時期に書かれたもの）が Blob に残っている。`alignment.get("extraPlayed", alignment["extra"])` で degrade させ、採点自体は落とさない。

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_metrics.py` に追記する（既存ファイルの import と補助関数を再利用する。ファイル冒頭を読んで既存の参照譜フィクスチャの作り方に合わせること）。

```python
class PitchUsesExtraPlayedTest(unittest.TestCase):
    def _fixture(self):
        reference = {
            "notes": [
                {"index": i, "pitch": 60 + i, "measure": 1,
                 "startBeat": float(i), "endBeat": float(i) + 1.0, "dynamicLevel": None}
                for i in range(4)
            ],
            "beatsPerMeasure": 4.0,
            "measures": [{"measure": 1, "tempoExcluded": False}],
            "capabilities": {"dynamics": False, "pedal": False},
        }
        est = [
            {"index": i, "pitch": 60 + i, "start": float(i), "end": float(i) + 0.5, "velocity": 80}
            for i in range(4)
        ] + [
            {"index": 4, "pitch": 60, "start": 0.01, "end": 0.5, "velocity": 80},
        ]
        alignment = {
            "pairs": [[i, i] for i in range(4)],
            "missed": [],
            "unplayed": [],
            "retakes": [],
            "extra": [4],
            "extraNoise": [4],
            "extraPlayed": [],
            "extraNoiseByReason": {"duplicate": 1, "harmonic": 0, "spurious": 0, "reverb": 0},
        }
        return reference, est, alignment

    def test_noise_classified_extra_does_not_lower_pitch(self):
        reference, est, alignment = self._fixture()
        result = metrics.compute(reference, est, alignment, [], [])
        self.assertEqual(result["metrics"]["pitch"], 100.0)

    def test_played_extra_lowers_pitch(self):
        reference, est, alignment = self._fixture()
        alignment["extraNoise"] = []
        alignment["extraPlayed"] = [4]
        alignment["extraNoiseByReason"] = {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}
        result = metrics.compute(reference, est, alignment, [], [])
        self.assertLess(result["metrics"]["pitch"], 100.0)

    def test_alignment_without_the_split_falls_back_to_extra(self):
        # 分類キーが無い古い alignment.json でも採点を落とさない。
        reference, est, alignment = self._fixture()
        for key in ("extraNoise", "extraPlayed", "extraNoiseByReason"):
            alignment.pop(key)
        result = metrics.compute(reference, est, alignment, [], [])
        self.assertLess(result["metrics"]["pitch"], 100.0)
```

- [ ] **Step 2: 失敗することを確認する**

Run: `cd worker && python tests/test_metrics.py`
Expected: FAIL — `test_noise_classified_extra_does_not_lower_pitch` が 100.0 にならない（現在の `compute` は `extra` を計上するため）

- [ ] **Step 3: 実装する**

`worker/ledgerlines_worker/metrics.py:131-137` を次にする。

```python
    extra_by_measure: dict[int, int] = {}
    # 採点に計上するのは弾き間違い（extraPlayed）だけで、採譜アーティファクト
    # （extraNoise）は計上しない（設計 4.2）。分類キーが無い古い alignment.json は
    # 全件を extra として扱い、採点を落とさずに degrade させる。
    for e_idx in alignment.get("extraPlayed", alignment["extra"]):
        b = sec_to_beat(beats, secs, est_notes[e_idx]["start"])
        if np.isnan(b):
            continue
        m = int(b // bpm_measure) + 1
        extra_by_measure[m] = extra_by_measure.get(m, 0) + 1
```

`worker/ledgerlines_worker/confidence.py` の `alignment_evidence` の `overall` dict（`:86-95` 付近、`"extraNotes"` の直後）に3行を足す。

```python
        "extraPlayedNotes": len(alignment.get("extraPlayed", alignment.get("extra", []))),
        "extraNoiseNotes": len(alignment.get("extraNoise", [])),
        "extraNoiseByReason": alignment.get(
            "extraNoiseByReason", {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}
        ),
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd worker && python tests/test_metrics.py`
Expected: PASS

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS（diagnostics のキーが増えるだけで既存の assert は壊れない想定。壊れた場合はキーの追加漏れではなく期待値の作り方を確認する）

Run: `cd worker && python tests/test_extra_classification.py`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add worker/ledgerlines_worker/metrics.py worker/ledgerlines_worker/confidence.py worker/tests/test_metrics.py
git commit -m "feat: score pitch from played mistakes only and expose the split"
```

---

## Task 4: poc の align / compute_metrics を worker の import に寄せる

**Files:**
- Modify: `poc/scripts/align.py`（アルゴリズム本体を削除し CLI だけ残す）
- Modify: `poc/scripts/compute_metrics.py`（同様）

**Interfaces:**
- Consumes: `ledgerlines_worker.align.align` / `load_est` / `JUMP_PENALTY`、`ledgerlines_worker.metrics.compute` / `load_est` / `pedal_intervals`
- Produces: `poc/scripts/align.py` と `compute_metrics.py` の CLI（引数・出力ファイル名・summary の形）は**現状のまま**

**背景（実装者向け）**

設計 §9.1 の対応。`poc/scripts/align.py` は `worker/ledgerlines_worker/align.py` の複製（82% 一致、差は docstring と CLI のみ）で、このままでは検証が旧式を測る。

**2つの実装には意図的な差がある。** 突き合わせて吸収すること。

| | poc | worker |
|---|---|---|
| `load_est` | `(est_notes, est_pedal)` を返す（compute_metrics 側） | `align.load_est` は音符だけ、`metrics.load_est` が `(音符, ペダル)` |
| `compute` の第5引数 | `ref_pedal`（**秒**の区間） | `ref_pedal_beats`（**拍**の区間）。内部で `pedal_intervals_from_beats` が秒へ変換 |
| `compute` の `degraded` | 引数なし | `degraded: bool = False` |

worker 側の署名に合わせる。参照譜のペダルは Task 6 で `pedalIntervalsBeats`（拍）として出力するので、poc 側は `reference.get("pedalIntervalsBeats", [])` を渡す。

- [ ] **Step 1: worker をパスに載せる共通の書き方を決める**

両ファイルの import 部に置く（`poc/scripts/x.py` → `parents[2]` がリポジトリルート）。

```python
import sys
from pathlib import Path

# 段3 以降、アルゴリズムの実体は worker 側の1つだけ（設計 9.1）。
# ここは検証用の CLI で、本番と同じコードを呼ぶ。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.align import JUMP_PENALTY, align, load_est  # noqa: E402
```

- [ ] **Step 2: `poc/scripts/align.py` を CLI だけにする**

`group_events` / `cost_matrix` / `dtw_path` / `dtw_path_jump` / `match_within` / `_match_path` / `align` / `load_est` の定義をすべて削除し、上記 import に置き換える。`main()` は**変更しない**。ただし summary の行に分類の内訳を足す（`row` の `"extra"` の直後）。

```python
                "extraNoise": len(result.get("extraNoise", [])),
                "extraPlayed": len(result.get("extraPlayed", [])),
```

print 文にも足す。

```python
            print(
                f"{name}/{cond}: ref={row['refNotes']} est={row['estNotes']} "
                f"pairs={row['pairs']} missed={row['missed']} unplayed={row['unplayed']} "
                f"retake={row['retakes']} extra={row['extra']} "
                f"(noise={row['extraNoise']} played={row['extraPlayed']}) takes={row['takes']}"
            )
```

ファイル冒頭の docstring は、アルゴリズムの説明ではなく「worker の align を呼ぶ検証 CLI である」ことを述べる形に書き換える（アルゴリズムの説明は worker 側にあるので重複させない）。

- [ ] **Step 3: `poc/scripts/compute_metrics.py` を CLI だけにする**

同様に指標の実装をすべて削除し、次に置き換える。

```python
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.metrics import compute, load_est, pedal_intervals  # noqa: E402
```

`main()` の `:292-294` を次にする。

```python
        est_notes, est_pedal = load_est(args.transcribed / f"{name}.{cond}.mid")
        # 参照譜のペダルは拍で持つ（worker の compute が拍を受け取り内部で秒へ直す）。
        ref_pedal_beats = reference.get("pedalIntervalsBeats", [])
        result = compute(reference, est_notes, alignment, est_pedal, ref_pedal_beats)
```

`pretty_midi` の import と `args.dataset` の使用が不要になるなら削除する（`--dataset` 引数は他の呼び出し元との互換のため残す）。

- [ ] **Step 4: import が通り、既存の CLI が壊れていないことを確認する**

Run: `cd poc && python -c "import sys; sys.argv=['x','--help']; exec(open('scripts/align.py').read())"`
Expected: argparse のヘルプが表示される（import 解決が成功している証拠）

Run: `cd poc && python -c "import sys; sys.argv=['x','--help']; exec(open('scripts/compute_metrics.py').read())"`
Expected: 同様

Run: `git grep -n "def align\|def compute(" -- poc/scripts/align.py poc/scripts/compute_metrics.py`
Expected: 出力なし（複製が消えている証拠）

- [ ] **Step 5: コミット**

```bash
git add poc/scripts/align.py poc/scripts/compute_metrics.py
git commit -m "refactor: run the poc harness against the worker's own align and metrics"
```

---

## Task 5: MIDI だけでデータセットを組む

**Files:**
- Modify: `poc/scripts/prepare_dataset.py`

**Interfaces:**
- Consumes: `poc/data/maestro-midi.zip`（取得済み）
- Produces: `--midi-only` 指定時、`data/dataset/pieceNN.ref.mid` と `data/dataset/dataset.json` を音声なしで出力する。`dataset.json` の各要素は `{"name", "source_midi", "window", "duration", "note_count", "pedal_cc_count", "audio": false}`

**背景（実装者向け）**

設計 §9.2。現在の `main()` は `data/raw*/manifest.json`（音声抽出の産物）が無いと `no raw entries found` で終了する。フェーズ1 は音声を使わないので、MIDI zip だけで完結する経路を足す。

窓の開始位置は、音声のオンセット検出（`find_onset_start`）の代わりに **MIDI の最初の音符の開始時刻**を使う。MAESTRO の MIDI は先頭に無音を持つことがある。

- [ ] **Step 1: 引数と分岐を足す**

```python
    ap.add_argument(
        "--midi-only",
        action="store_true",
        help="音声を使わず MIDI zip だけでデータセットを組む（フェーズ1 用。設計 9.2）",
    )
    ap.add_argument("--limit", type=int, default=5, help="--midi-only で切り出す曲数")
```

- [ ] **Step 2: MIDI 専用の組み立てを実装する**

`main()` の `raw_dirs` を読む前に分岐を置く。

```python
def prepare_midi_only(midi_zip: Path, out: Path, seconds: float, limit: int) -> int:
    """MIDI zip だけからデータセットを組む（設計 9.2、フェーズ1 用）。

    音声を使わないので窓の開始は MIDI の最初の音符に合わせる。
    採譜を経由しない検証（perturb.py）にはこれで十分で、
    録音条件不変性（フェーズ2）にはこの経路は使えない。
    """
    out.mkdir(parents=True, exist_ok=True)
    zf = zipfile.ZipFile(midi_zip)
    midi_names = sorted(n for n in zf.namelist() if n.lower().endswith((".midi", ".mid")))
    dataset = []
    for idx, zip_key in enumerate(midi_names[:limit]):
        with zf.open(zip_key) as fh:
            pm = pretty_midi.PrettyMIDI(io.BytesIO(fh.read()))
        notes = sorted(pm.instruments[0].notes, key=lambda n: n.start)
        if not notes:
            print(f"[skip] no notes: {zip_key}")
            continue
        start = float(notes[0].start)
        end = min(start + seconds, pm.get_end_time())
        sliced = slice_midi(pm, start, end)
        name = f"piece{idx:02d}"
        sliced.write(str(out / f"{name}.ref.mid"))
        pedal_cc = [c for c in sliced.instruments[0].control_changes if c.number == 64]
        info = {
            "name": name,
            "source_midi": zip_key,
            "window": [round(start, 3), round(end, 3)],
            "duration": round(end - start, 3),
            "note_count": len(sliced.instruments[0].notes),
            "pedal_cc_count": len(pedal_cc),
            "audio": False,
        }
        dataset.append(info)
        print(
            f"{name}: {info['duration']:.1f}s notes={info['note_count']} "
            f"pedalCC={info['pedal_cc_count']} src={Path(zip_key).name}"
        )
    (out / "dataset.json").write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nprepared {len(dataset)} piece(s) in {out} (midi only)")
    return 0
```

`main()` の冒頭（`args = ap.parse_args()` の直後）に足す。

```python
    if args.midi_only:
        return prepare_midi_only(args.midi_zip, args.out, args.seconds, args.limit)
```

`io` を import に追加する。

- [ ] **Step 3: 実行して確認する**

Run: `cd poc && python scripts/prepare_dataset.py --midi-only --midi-zip data/maestro-midi.zip --limit 5`
Expected: `piece00` 〜 `piece04` の5行が出て `prepared 5 piece(s) in data\dataset (midi only)`。各行の `notes` が数百〜千数百件、`duration` が 90.0 前後

Run: `cd poc && python -c "import json; d=json.load(open('data/dataset/dataset.json',encoding='utf-8')); print(len(d), [x['note_count'] for x in d])"`
Expected: `5 [...]`（すべて 0 でないこと）

- [ ] **Step 4: コミット**

```bash
git add poc/scripts/prepare_dataset.py
git commit -m "feat: build the poc dataset from MIDI alone"
```

---

## Task 6: MIDI 由来の等間隔グリッドで参照譜を作る

**Files:**
- Modify: `poc/scripts/make_reference.py`

**Interfaces:**
- Consumes: `data/dataset/pieceNN.ref.mid` と `dataset.json`（Task 5）
- Produces: `--midi-only` 指定時、`out/reference/pieceNN.reference.json` を音声・librosa なしで出力する。doc に `pedalIntervalsBeats`（拍の区間）を追加する

**背景（実装者向け）**

設計 §9.2。`estimate_beat_grid()` は `librosa.beat.beat_track` で音声から拍を推定するが、librosa はホストにもワーカーイメージにも無い。MAESTRO の MIDI は 120 BPM / 4-4 固定のプレースホルダで（実測）、楽譜由来のテンポマップを持たない。

**分割数は 16 とする。** MAESTRO 5曲の先頭90秒で同一ピッチ音符の最小オンセット間隔を実測したところ、8分割（0.0625秒）では1曲でトリルが同一格子に潰れた（最小 0.0604秒）。16分割（0.03125秒）なら5曲すべてで潰れない。

**この経路の rhythm / tempo は意味を持たない**（拍が音楽的な拍ではない）。出力に明示する。

- [ ] **Step 1: MIDI 由来グリッドと引数を足す**

```python
MIDI_ONLY_SUBDIVISION = 16  # 設計 9.2（8分割ではトリルが潰れることを実測）
MIDI_ONLY_TEMPO_BPM = 120.0  # MAESTRO の MIDI が持つ固定テンポ


def midi_only_beat_grid(pm: pretty_midi.PrettyMIDI) -> tuple[np.ndarray, np.ndarray, float]:
    """MIDI のオンセットから等間隔の拍格子を作る（設計 9.2）。

    音声の拍トラッキングを使わないので librosa を必要としない。フェーズ1 の合格条件は
    missed / extra の個数で決まり拍の音楽的正しさに依存しないため、推定誤差を持ち込む
    音声由来の拍より、厳密なオンセットに対する等間隔格子のほうが適している。

    **この格子で算出した rhythm / tempo は音楽的な意味を持たない。**
    """
    beat_sec = 60.0 / MIDI_ONLY_TEMPO_BPM
    end = max(pm.get_end_time(), beat_sec)
    n_beats = int(np.ceil(end / beat_sec)) + 2
    grid_times = []
    grid_beats = []
    for i in range(n_beats):
        for s in range(MIDI_ONLY_SUBDIVISION):
            frac = s / MIDI_ONLY_SUBDIVISION
            grid_times.append((i + frac) * beat_sec)
            grid_beats.append(i + frac)
    return np.array(grid_times), np.array(grid_beats), MIDI_ONLY_TEMPO_BPM
```

引数を足す。

```python
    ap.add_argument(
        "--midi-only",
        action="store_true",
        help="音声を使わず MIDI 由来の等間隔グリッドで参照譜を作る（設計 9.2）",
    )
```

- [ ] **Step 2: main の分岐と `pedalIntervalsBeats` を実装する**

`main()` のループ内（`:99-101`）を次にする。

```python
        pm = pretty_midi.PrettyMIDI(str(args.dataset / f"{piece['name']}.ref.mid"))
        if args.midi_only:
            grid_t, grid_b, tempo = midi_only_beat_grid(pm)
        else:
            audio, sr = sf.read(args.dataset / f"{piece['name']}.clean.wav", dtype="float32")
            grid_t, grid_b, tempo = estimate_beat_grid(audio, sr)
```

`doc` に `pedalIntervalsBeats` を足す（`"beatMap": beat_map,` の直後）。worker の `compute` が拍で受け取るため（Task 4）。

```python
            "pedalIntervalsBeats": [
                [round(float(np.interp(a, grid_t, grid_b)), 4),
                 round(float(np.interp(b, grid_t, grid_b)), 4)]
                for a, b in pedal_intervals_sec(pm)
            ],
            "gridSource": "midi" if args.midi_only else "audio",
```

ペダル区間の抽出は**再実装せず worker の関数を使う**。ファイル先頭の import 部に足す
（`poc/scripts/x.py` → `parents[2]` がリポジトリルート）。

```python
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.metrics import pedal_intervals as pedal_intervals_sec  # noqa: E402
```

`librosa` の import はファイル先頭では**そのまま残す**（`--midi-only` でない従来経路が使う）。ただし librosa が無い環境で `--midi-only` を使えるよう、**import を `estimate_beat_grid` の内側へ移す**。

```python
def estimate_beat_grid(audio: np.ndarray, sr: int = SR) -> np.ndarray:
    """音声からビート時刻を推定し、拍内を細分した格子時刻を返す。"""
    import librosa  # --midi-only では不要なので遅延 import する

    tempo, beats = librosa.beat.beat_track(y=audio, sr=sr, units="time", trim=False)
```

- [ ] **Step 3: 実行して確認する**

Run: `cd poc && python scripts/make_reference.py --midi-only`
Expected: 5曲ぶんの行が出る。エラーなし（librosa 未インストールでも通ること）

Run: `cd poc && python -c "import json,glob; d=json.load(open(sorted(glob.glob('out/reference/*.reference.json'))[0],encoding='utf-8')); print(d['gridSource'], d['measureCount'], len(d['notes']), len(d['pedalIntervalsBeats']))"`
Expected: `midi <小節数> <音符数> <ペダル区間数>` で、小節数・音符数が 0 でないこと

Run: `cd poc && python -c "
import json,glob
d=json.load(open(sorted(glob.glob('out/reference/*.reference.json'))[0],encoding='utf-8'))
beats=[n['startBeat'] for n in d['notes']]
print('unique startBeat', len(set(beats)), 'of', len(beats))
"`
Expected: `unique startBeat` が音符数の 80% 以上（同一格子への潰れが起きていない目安。和音は同じ拍を共有するので 100% にはならない）

- [ ] **Step 4: コミット**

```bash
git add poc/scripts/make_reference.py
git commit -m "feat: derive the poc reference grid from MIDI so phase 1 needs no audio"
```

---

## Task 7: フェーズ1 — 弁別力の測定と τ 候補の掃引

**Files:**
- Create: `poc/scripts/sweep_pitch_tau.py`
- Create: `docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md`

**Interfaces:**
- Consumes: `out/reference/*.reference.json`（Task 6）、`out/transcribed/*.mid`（`perturb.py` の出力）、`ledgerlines_worker.align.align` / `metrics.compute`
- Produces: `out/metrics/pitch-sweep.json`（候補ごとの pitch と4条件の判定）と、結果文書の表

**背景（実装者向け）**

設計 §5.1 の合格条件4項目を判定する。

1. `perturbation=none`（完璧な演奏）で pitch ≥ 90
2. `drop 5%` と `drop 10%` が分離する（前者が高い）
3. `add 5%`（隣接半音の誤打）で pitch が低下する ← **本フェーズの主眼**。extra 分類が弾き間違いを `extraNoise` に誤分類していないこと
4. 摂動率を上げるほど pitch が単調非増加（`drop` と `add` それぞれ）

**τ は掃引で決める。** `TAU_PITCH` と `W_EXTRA` は `metrics.py` のモジュール変数で、`decay(e_pitch, TAU_PITCH)` は呼び出し時に読むため、ハーネスから代入して切り替えられる。**式を再実装してはいけない**（複製になる）。

`perturb.py` が生成する条件名は `python scripts/perturb.py` を実行して `out/transcribed/` のファイル名から確認すること（`pieceNN.<condition>.mid` の形）。

- [ ] **Step 1: 摂動を生成し、条件名を確認する**

Run: `cd poc && python scripts/perturb.py`
Expected: `out/transcribed/` に `pieceNN.<condition>.mid` が生成される

Run: `cd poc && python -c "
import glob, os, re
conds = sorted({re.match(r'piece\d+\.(.+)\.mid$', os.path.basename(p)).group(1) for p in glob.glob('out/transcribed/*.mid')})
print(len(conds), conds)
"`
Expected: 12前後の条件名が出る（`none` と、`drop` / `add` を含む名前があること）

- [ ] **Step 2: 掃引ハーネスを書く**

`poc/scripts/sweep_pitch_tau.py`

```python
"""(TAU_PITCH, W_EXTRA) の候補を掃引し、設計 5.1 の合格条件4項目を判定する。

指標の式は worker の metrics.compute をそのまま使う（設計 9.1）。ここでは
モジュール変数を差し替えて候補を切り替えるだけで、式を再実装しない。

**フェーズ1 は採譜を通さないため、extra 分類が実在のアーティファクトを除去できるかは
測れない（設計 9.3）。ここで測るのは弁別力だけである。**
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker import metrics as metrics_mod  # noqa: E402
from ledgerlines_worker.align import align  # noqa: E402
from ledgerlines_worker.metrics import load_est  # noqa: E402

TAU_CANDIDATES = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40]
W_EXTRA_CANDIDATES = [0.3, 0.5, 0.7]


def rate_of(condition: str) -> float | None:
    """条件名から摂動率を取り出す（例 'drop05' -> 0.05）。取れなければ None。"""
    m = re.search(r"(\d+)$", condition)
    return int(m.group(1)) / 100.0 if m else None


def pitch_for(reference: dict, mid_path: Path, tau: float, w_extra: float) -> float | None:
    est_notes, est_pedal = load_est(mid_path)
    alignment = align(reference, est_notes, mode="jump", est_pedal=est_pedal)
    metrics_mod.TAU_PITCH = tau
    metrics_mod.W_EXTRA = w_extra
    result = metrics_mod.compute(
        reference,
        est_notes,
        alignment,
        est_pedal,
        reference.get("pedalIntervalsBeats", []),
    )
    return result["metrics"]["pitch"]


def evaluate(rows: list[dict]) -> dict:
    """設計 5.1 の4条件を判定する。rows は {condition, rate, pitch} の列。"""
    by_cond = {r["condition"]: r["pitch"] for r in rows if r["pitch"] is not None}
    none_pitch = by_cond.get("none")

    def family(prefix: str) -> list[tuple[float, float]]:
        out = []
        for r in rows:
            if r["pitch"] is None or not r["condition"].startswith(prefix):
                continue
            rate = rate_of(r["condition"])
            if rate is not None:
                out.append((rate, r["pitch"]))
        return sorted(out)

    drops, adds = family("drop"), family("add")
    c1 = none_pitch is not None and none_pitch >= 90.0
    c2 = len(drops) >= 2 and drops[0][1] > drops[-1][1]
    c3 = bool(adds) and none_pitch is not None and adds[0][1] < none_pitch
    c4 = all(
        all(b[1] <= a[1] + 1e-9 for a, b in zip(fam, fam[1:]))
        for fam in (drops, adds)
        if len(fam) >= 2
    )
    return {
        "nonePitch": none_pitch,
        "c1_none_at_least_90": c1,
        "c2_drop_separates": c2,
        "c3_add_lowers": c3,
        "c4_monotonic": c4,
        "passed": all([c1, c2, c3, c4]),
        "drops": drops,
        "adds": adds,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--out", type=Path, default=Path("out/metrics/pitch-sweep.json"))
    args = ap.parse_args()

    references = {
        p.name.split(".")[0]: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(args.reference.glob("*.reference.json"))
    }
    if not references:
        print("no references found; run make_reference.py first")
        return 1

    results = []
    for tau in TAU_CANDIDATES:
        for w_extra in W_EXTRA_CANDIDATES:
            rows = []
            for name, reference in references.items():
                for mid in sorted(args.transcribed.glob(f"{name}.*.mid")):
                    condition = mid.name[len(name) + 1 : -len(".mid")]
                    rows.append(
                        {
                            "name": name,
                            "condition": condition,
                            "pitch": pitch_for(reference, mid, tau, w_extra),
                        }
                    )
            # 曲ごとの差を平均して条件単位に畳む
            by_cond: dict[str, list[float]] = {}
            for r in rows:
                if r["pitch"] is not None:
                    by_cond.setdefault(r["condition"], []).append(r["pitch"])
            mean_rows = [
                {"condition": c, "pitch": sum(v) / len(v)} for c, v in sorted(by_cond.items())
            ]
            verdict = evaluate(mean_rows)
            results.append({"tau": tau, "wExtra": w_extra, **verdict, "rows": mean_rows})
            print(
                f"tau={tau} w_extra={w_extra} none={verdict['nonePitch']} "
                f"c1={verdict['c1_none_at_least_90']} c2={verdict['c2_drop_separates']} "
                f"c3={verdict['c3_add_lowers']} c4={verdict['c4_monotonic']} "
                f"=> {'PASS' if verdict['passed'] else 'fail'}"
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = [r for r in results if r["passed"]]
    print(f"\n{len(passed)}/{len(results)} candidate(s) passed all four criteria")
    print("NOTE: phase 1 does not exercise transcription, so it cannot show whether the")
    print("      extra classifier removes real artifacts (design 9.3). That is leg 2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: 掃引を実行する**

Run: `cd poc && python scripts/sweep_pitch_tau.py`
Expected: 18行（6 τ × 3 W_EXTRA）が出て、末尾に合格数が出る

**条件3（`add` で pitch が下がる）が全候補で false の場合、それは τ の問題ではなく extra 分類が弾き間違いを `extraNoise` に誤分類しているということである。** その場合は Task 1 の分類規則に戻ること（`add` の摂動が隣接半音＝`abs(diff) == 1` なので、規則2の `abs(diff) == 12` に該当してはならない。該当しているなら実装のバグ）。

- [ ] **Step 4: 結果を記録する**

`docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md` を作り、次を書く。

- 実行したコマンド列（`prepare_dataset --midi-only` から `sweep_pitch_tau.py` まで）
- 使用した MAESTRO の曲数と、各曲の音符数・窓
- 掃引の表（τ × W_EXTRA × 4条件の判定 × `none` / `drop` / `add` の pitch）
- **合格した候補の一覧**
- グリッドが MIDI 由来であること（設計 9.2）と、**この harness の rhythm / tempo は意味を持たないこと**
- フェーズ1 が τ を確定できない理由（設計 9.3）— 確定は Task 9

- [ ] **Step 5: コミット**

```bash
git add poc/scripts/sweep_pitch_tau.py docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md
git commit -m "test: measure pitch discrimination across tau and W_EXTRA candidates"
```

---

## Task 8: 脚2 — 実録音の採譜で分類の実在性を測る

**Files:**
- Create: `poc/scripts/measure_real_take.py`
- Modify: `docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md`（脚2 の節を追記）

**Interfaces:**
- Consumes: `.data/audio/<takeId>/original.webm`（実録音、168秒）、`.data/derived/<songId>/reference.json`（実データの参照譜）、`ledgerlines_worker` の transcribe / align / metrics
- Produces: `out/metrics/real-take.json` — `extraNoiseByReason` の内訳と、τ 候補ごとの pitch

**背景（実装者向け）**

設計 §9.3 の脚2。フェーズ1 は採譜を通さないため、extra 分類が除去対象とするアーティファクト（二重検出・倍音ゴースト・スプリアス・残響）が1件も存在しない。**実在のアーティファクトに対する効果と τ の位置は、実録音でしか測れない。**

**採譜には torch と採譜チェックポイントが必要で、これはワーカーコンテナに同梱されている。** ホストには無いのでコンテナ内で実行する。イメージは #33 の作業で再ビルド済みだが、**`worker/` のコードを変更した後は再ビルドが必要**（`docker compose -f docker-compose.azure-local.yml build worker`）。再ビルドせずに実行すると Task 1〜3 の変更が入っていない古いコードを測ることになる。

実録音は1件なので分布を語れない。**用途は τ 候補の裏付けに限る**（設計 9.3）。

- [ ] **Step 1: 実データの所在を確認する**

Run: `ls .data/audio/*/original.webm; ls .data/derived/*/reference.json; ls .data/takes/*.json`
Expected: 録音・参照譜・テイクの JSON が存在する。存在しない場合は `.data` が消えているので、`docs/operations/local-azure.md` の手順で実データを1件用意してから進める（この場合はその旨を報告し、Task 9 の判断材料が欠けることを明示する）

- [ ] **Step 2: 測定スクリプトを書く**

`poc/scripts/measure_real_take.py`

```python
"""実録音1件を採譜し、extra 分類の内訳と τ 候補ごとの pitch を測る（設計 9.3 の脚2）。

フェーズ1（摂動）は採譜を通さないため、分類が除去対象とするアーティファクトが
存在しない。ここは実在のアーティファクトに対する効果を測る唯一の脚である。

**1件なので分布は語れない。τ 候補の裏付けにのみ使う。**
torch と採譜チェックポイントが必要なので、ワーカーコンテナ内で実行する。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker import metrics as metrics_mod  # noqa: E402
from ledgerlines_worker import preprocess as preprocess_mod  # noqa: E402
from ledgerlines_worker import transcribe as transcribe_mod  # noqa: E402
from ledgerlines_worker.align import align  # noqa: E402
from ledgerlines_worker.metrics import load_est  # noqa: E402

TAU_CANDIDATES = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40]
W_EXTRA_CANDIDATES = [0.3, 0.5, 0.7]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", type=Path, required=True, help="実録音（webm / wav）")
    ap.add_argument("--reference", type=Path, required=True, help="実データの reference.json")
    ap.add_argument("--work", type=Path, default=Path("out/real-take"))
    ap.add_argument("--out", type=Path, default=Path("out/metrics/real-take.json"))
    args = ap.parse_args()

    args.work.mkdir(parents=True, exist_ok=True)
    reference = json.loads(args.reference.read_text(encoding="utf-8"))

    # 前処理と採譜は本番と同じ呼び方をする（worker_main.py:294-297 と同一）。
    # preprocess は dict を返し ["path"] に前処理済み wav のパスが入る。
    # transcribe は書き出し先のパスを受け取る（戻り値ではなく引数で渡す）。
    pre = preprocess_mod.preprocess(args.audio, args.work)
    midi_path = args.work / "transcription.mid"
    transcribe_mod.transcribe(pre["path"], midi_path)

    est_notes, est_pedal = load_est(midi_path)
    alignment = align(reference, est_notes, mode="jump", est_pedal=est_pedal)

    breakdown = {
        "referenceNotes": len(reference["notes"]),
        "transcribedNotes": len(est_notes),
        "matchedNotes": len(alignment["pairs"]),
        "missedNotes": len(alignment["missed"]),
        "extraNotes": len(alignment["extra"]),
        "extraNoiseNotes": len(alignment["extraNoise"]),
        "extraPlayedNotes": len(alignment["extraPlayed"]),
        "extraNoiseByReason": alignment["extraNoiseByReason"],
        "noiseShare": (
            len(alignment["extraNoise"]) / len(alignment["extra"]) if alignment["extra"] else None
        ),
    }

    grid = []
    for tau in TAU_CANDIDATES:
        for w_extra in W_EXTRA_CANDIDATES:
            metrics_mod.TAU_PITCH = tau
            metrics_mod.W_EXTRA = w_extra
            result = metrics_mod.compute(
                reference,
                est_notes,
                alignment,
                est_pedal,
                reference.get("pedalIntervalsBeats", []),
            )
            grid.append(
                {"tau": tau, "wExtra": w_extra, "pitch": result["metrics"]["pitch"]}
            )
            print(f"tau={tau} w_extra={w_extra} pitch={result['metrics']['pitch']}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"breakdown": breakdown, "grid": grid}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n" + json.dumps(breakdown, ensure_ascii=False, indent=2))
    print("NOTE: one recording cannot describe a distribution (design 9.3).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`pre_mod` / `transcribe_mod` の関数名と引数は**推測せず** `worker/worker_main.py` の `run_analyze()` を読んで合わせること。合わない場合は NEEDS_CONTEXT で報告する。

- [ ] **Step 3: ワーカーイメージを再ビルドしてコンテナ内で実行する**

```bash
docker compose -f docker-compose.azure-local.yml build worker
docker compose -f docker-compose.azure-local.yml run --rm \
  -v "${PWD}/poc:/app/poc" -v "${PWD}/.data:/app/.data" \
  worker python /app/poc/scripts/measure_real_take.py \
  --audio /app/.data/audio/<takeId>/original.webm \
  --reference /app/.data/derived/<songId>/reference.json
```

マウントのパスとイメージ内の作業ディレクトリは `worker/Dockerfile` と `docker-compose.azure-local.yml` を読んで合わせること。採譜は RTF 1.2 前後なので 168 秒の録音で数分かかる。

Expected: `extraNoiseByReason` の内訳と、18通りの `pitch` が出る

- [ ] **Step 4: 結果を記録する**

結果文書に脚2 の節を追記する。

- 使用した録音（長さ、曲）と、採譜の結果（`transcribedNotes` / `matchedNotes` / `missedNotes` / `extraNotes`）
- **`extraNoise` の内訳と `noiseShare`**（extra 全体のうち分類が除去した割合）
- τ × W_EXTRA ごとの pitch の表
- `worker/tests/fixtures/issue8_take_diagnostic.json` の数値（参照 1242 / matched 974 / missed 268 / extra 521）との比較。桁が違う場合はその理由（曲・長さの違い）を書く
- **1件では分布を語れないという限界**（設計 9.3）

- [ ] **Step 5: コミット**

```bash
git add poc/scripts/measure_real_take.py docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md
git commit -m "test: measure the extra split against a real transcription"
```

---

## Task 9: τ / W_EXTRA の確定と pitch の保留解除

**Files:**
- Modify: `worker/ledgerlines_worker/metrics.py:15-17`
- Modify: `worker/ledgerlines_worker/confidence.py:153-157`
- Modify: `worker/tests/test_confidence.py`
- Modify: `worker/tests/fixtures/issue8_take_diagnostic.json`
- Modify: `docs/spec/metrics.md`（3.1 pitch）
- Modify: `docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md`（確定の節）

**Interfaces:**
- Consumes: Task 7 の掃引結果と Task 8 の実測
- Produces: `TAU_PITCH` / `W_EXTRA` の確定値。`decide("pitch")` が `scored` を返し得るようになり、`overallScore` が数値になる

**決定規則（実装者はこれに従う。値を勘で選ばない）**

1. Task 7 で**4条件すべてに合格した候補**だけを対象にする。1つも無い場合は Task 1 の分類規則か Task 6 の参照譜構築に問題があるので、**確定せず BLOCKED で報告する**
2. そのうち Task 8 の実測が次を満たすものに絞る
   - `noiseShare ≥ 0.50`（実在の extra の半分以上を分類が除去できている。設計 §2.2 は extra が誤りの 58% を占めると測っている。ここが満たせないならアーティファクト問題は未解決）
   - 実録音の `pitch` が **20 < pitch < 95**（床に張り付いてもいない、飽和してもいない）
3. 残った候補のうち **τ が最小のもの**を選ぶ。τ が小さいほど採点は厳しく、点数を甘く見せるリスクが小さい
4. 2 で候補が全滅した場合は、1 の合格候補のうち τ が最小のものを選び、**`noiseShare` と実録音 pitch の実測値を結果文書に明記して「実データ根拠が弱い」ことを残す**

- [ ] **Step 1: 失敗するテストを書く**

**新しいテストを足すのではなく、既存の `test_issue_8_diagnostic_withholds_pitch_only`（`worker/tests/test_confidence.py:68`）を書き換える。** このテストは段2 の「pitch だけが保留」を assert しており、段3 で前提が変わる（設計 5.3）。

既存の `_issue8_case()`（`:16-66`）は `(result, reference, alignment, fixture)` を返し、**期待値をフィクスチャの `expected` から読む**作りになっている（テスト側にリテラルを書き写すとフィクスチャとの結合が切れるため、と docstring に理由が書かれている）。この作りを壊さないこと。

したがって手順は次になる。

1. `worker/tests/fixtures/issue8_take_diagnostic.json` の `expected` を、pitch が `scored` になり `overallScore` が数値になる形に更新する（具体値は τ 確定後の Step 5 で入れる。この段階では status と reasonCode だけを直す）
2. テストの名前を実態に合わせて `test_issue_8_diagnostic_scores_all_five_metrics` に変え、docstring を「段3 では pitch も採点され、overallScore が数値になる」に書き換える
3. `overallScore` が数値であることの assert を足す

さらに、対応付け根拠が足りない場合の保留は段3 でも変わらないので、それを守るテストを足す（既存の `_issue8_case()` を使い、`apply_fail_closed_policy` の第4引数＝採譜音符数を小さくして `matchRate` を下限未満にする。既存テストの `apply_fail_closed_policy(result, reference, alignment, 1, calibration)` の呼び方（`:368`）を参考にすること）。

```python
    def test_pitch_below_the_match_floor_is_still_withheld(self):
        """対応付け根拠が足りないときの保留は段3 でも変わらない（設計 5.3）。"""
        result, reference, alignment, _ = self._issue8_case()
        # 参照譜の音符数に対してマッチが極端に少ない alignment に差し替える
        alignment["pairs"] = alignment["pairs"][:1]
        alignment["missed"] = list(range(1, len(reference["notes"])))

        guarded = apply_fail_closed_policy(result, reference, alignment, 3)

        self.assertEqual(guarded["metricEvaluations"]["pitch"]["status"], "withheld")
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "ALIGNMENT_BELOW_FLOOR"
        )
        self.assertIsNone(guarded["overallScore"])
```

- [ ] **Step 2: 失敗することを確認する**

Run: `cd worker && python tests/test_confidence.py`
Expected: FAIL — pitch の status が `withheld`（`PITCH_FORMULA_UNVALIDATED`）で `overallScore` が None

- [ ] **Step 3: 定数を確定し保留を解除する**

`worker/ledgerlines_worker/metrics.py:15-17` を、決定規則で選んだ値に更新する。コメントで根拠と限界を明示する。

```python
W_MISS = 1.0
# 段3（Issue #40）で再校正した。根拠は MAESTRO MIDI の摂動応答（設計 5.1 の4条件）と
# 実録音1件の採譜結果（設計 9.3 の脚2）で、**教師較正ではない**。
# 測定の記録: docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md
W_EXTRA = <掃引で確定した値>
TAU_PITCH = <掃引で確定した値>
```

`worker/ledgerlines_worker/confidence.py:153-157` の pitch 固定保留を**削除する**。

```python
        if below_floor:
            return "withheld", "ALIGNMENT_BELOW_FLOOR"
        if key == "dynamics":
```

`decide()` の docstring から「pitch も同様に、素点の有無に関わらず式が未検証である」の一文を削除し、pitch が一般経路（素点があれば `scored`）を通るようになったことを書く。

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS

Run: `cd worker && python tests/test_extra_classification.py`
Expected: PASS

Run: `cd worker && python tests/test_metrics.py`
Expected: PASS

Run: `cd worker && python tests/test_calibration.py && python tests/test_teacher_metrics.py && python tests/test_reference.py && python tests/test_preprocess.py && python tests/test_worker_main.py && python tests/test_score_job.py`
Expected: すべて `OK`（設計 5.3 は `test_metrics` / `test_calibration` / `test_teacher_metrics` を変更しないと定めている。壊れた場合は変更が広すぎる）

- [ ] **Step 5: フィクスチャを回帰値として固定する**

`worker/tests/fixtures/issue8_take_diagnostic.json` に分類の内訳（`extraNoiseNotes` / `extraPlayedNotes` / `extraNoiseByReason`）を追記し、確定した τ での pitch を回帰値として記録する。設計 5.3 の2段階のうち第2段（τ 確定後の固定）に当たる。

Run: `cd worker && python tests/test_confidence.py`
Expected: PASS

- [ ] **Step 6: TypeScript 側とスモークの前提を確認する**

`overallScore` が数値になるので、null 前提のコードが無いかを確認する。

Run: `npm run test:unit && npm run test:production`
Expected: どちらも PASS

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: すべてエラーなし

Run: `git grep -n "overallScore" -- src/lib/real-history.ts src/components/TakeEvaluationPanel.tsx | head`
確認: null を前提に分岐している箇所が、数値でも正しく描くこと（#29 で nullable 化済みなので変更不要な見込み。変更が必要なら報告する）

Run: `git grep -n "overallScore" -- scripts/azure-local-smoke.ts scripts/production-check.ts`
確認: 設計 5.3 が求めている確認。スモークやプロダクションチェックが `overallScore` の null を前提に assert していないこと（現在のスモークは合成音声で `ALIGN_FAILED` に終端する経路を見ているので影響しない見込み。`overallScore === null` を期待している箇所があれば報告する）

- [ ] **Step 7: ドキュメントを更新する**

`docs/spec/metrics.md` の 3.1 pitch に次を書く。

- `extra` の分類（4規則と暫定閾値、フェーズ2 で確定予定であること）
- 確定した `W_EXTRA` / `TAU_PITCH` の値
- **根拠が摂動応答（設計 5.1）と実録音1件（設計 9.3）であること。教師較正の項目は「未」のまま残す**
- 段3 完了の意味は「`overallScore` が数値になる」ことであり、点数が音楽的に妥当と証明されたわけではないこと

結果文書に確定の節を追記する（選んだ値、決定規則のどの段で選ばれたか、却下した候補とその理由）。

- [ ] **Step 8: コミット**

```bash
git add worker/ledgerlines_worker/metrics.py worker/ledgerlines_worker/confidence.py \
  worker/tests/test_confidence.py worker/tests/fixtures/issue8_take_diagnostic.json \
  docs/spec/metrics.md docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md
git commit -m "feat: recalibrate the pitch formula and let overallScore be a number"
```

---

## 完了の定義

1. `extra` が `extraNoise` / `extraPlayed` に分類され、`e_pitch` が後者だけを計上する
2. 分類ロジックの実体が worker の1箇所だけにあり、`poc/scripts/` はそれを import している（`git grep "def align" -- poc/scripts/` が空）
3. フェーズ1 が MAESTRO MIDI zip だけで実行でき（librosa 不要）、設計 5.1 の4条件の判定結果が記録されている
4. 実録音1件に対する分類の内訳と τ 応答が記録されている
5. `TAU_PITCH` / `W_EXTRA` が決定規則に沿って確定し、根拠と限界が `metrics.md` に書かれている
6. **`decide("pitch")` が `scored` を返し得るようになり、`overallScore` が数値になる**（Issue #40 の完了条件）
7. ワーカーの unittest 8ファイルすべてと、`npm run test:unit` / `test:production` / `tsc --noEmit` / `lint` / `build` が通る

## この計画に含まれないもの

- **フェーズ2**（MAESTRO 音声による録音条件不変性、設計 5.2）。分類閾値の確定（5.2 の条件5）と `matchRate` 下限の検証（同条件6）もフェーズ2 に属する
- **教師較正**。τ の音楽的妥当性は本計画では検証しない（設計 4.3 / 8章 / 9.4）
- phone_agc での pitch の扱い（設計 8章、フェーズ2 の測定後に決める）
- 繰り返し展開（#37）、ダッシュボードの実データ化（#38）など他 issue の範囲
