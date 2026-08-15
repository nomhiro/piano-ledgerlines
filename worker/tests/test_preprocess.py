from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.preprocess import (  # noqa: E402
    DYNAMIC_RANGE_FRAME_SEC,
    DYNAMIC_RANGE_HOP_SEC,
    dynamic_range_db,
)
from ledgerlines_worker.scoring_constants import (  # noqa: E402
    AGC_DYNAMIC_RANGE_DB,
    DEGRADED_DYNAMIC_RANGE_DB,
)

SR = 16000
FRAME = round(DYNAMIC_RANGE_FRAME_SEC * SR)  # 2048
HOP = round(DYNAMIC_RANGE_HOP_SEC * SR)  # 512


def _tone(seconds: float = 4.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return np.sin(2 * np.pi * 440.0 * t).astype(np.float32)


def _decaying_notes(seed: int = 7, seconds: float = 12.0) -> np.ndarray:
    """打鍵ごとに音量が変わる減衰音列。生ピアノ録音の粗い代用。

    AGC ゲートを踏むテストの素材。単純な正弦波では「AGC をかけても値が変わらない」
    ので AGC の検出可否を確かめられない ── 押し潰される起伏（音ごとのレベル差と
    1音の減衰）が必要である。seed 固定で決定的。
    """
    rng = np.random.default_rng(seed)
    total = int(SR * seconds)
    out = np.zeros(total, dtype=np.float64)
    step = int(SR * 0.5)
    for start in range(0, total - step, step):
        length = min(int(SR * 1.2), total - start)
        t = np.arange(length) / SR
        level = float(rng.uniform(0.15, 1.0))
        freq = float(rng.uniform(220.0, 880.0))
        out[start : start + length] += level * np.exp(-t * 4.0) * np.sin(2 * np.pi * freq * t)
    out += rng.normal(0.0, 3e-4, total)  # ノイズフロア
    return (out / max(1e-9, float(np.max(np.abs(out))))).astype(np.float32)


def _apply_agc(audio: np.ndarray, block_sec: float = 0.2, target: float = 0.2) -> np.ndarray:
    """ブロック単位で RMS を一定に正規化し、スマホの AGC を模す。

    ブロック長 200 ms は m4-report 5.1 の phone_agc（実機の AGC）と同程度の時定数。
    これより短いブロックにすると1音の減衰まで平らになり、どんな推定量でも
    レンジがほぼ 0 になってしまうため、ゲートの識別力を測るには弱い条件を使う。
    """
    block = int(SR * block_sec)
    out = np.array(audio, dtype=np.float64)
    for start in range(0, len(out), block):
        segment = out[start : start + block]
        rms = float(np.sqrt(np.mean(np.square(segment)))) if segment.size else 0.0
        if rms > 1e-6:
            out[start : start + block] = segment * (target / rms)
    return np.clip(out, -1.0, 1.0).astype(np.float32)


class DynamicRangeTests(unittest.TestCase):
    """`dynamic_range_db` は poc/scripts/estimate_quality.py と同一の推定量である。

    10 dB / 14 dB の閾値は m4-report 5.1 でこの推定量によって実測されたので、
    ここでは「閾値を跨ぐ側／跨がない側」を実際に踏むことを確認する。
    """

    def test_wide_dynamics_exceed_degraded_threshold(self):
        tone = _tone()
        envelope = np.linspace(0.02, 1.0, tone.size, dtype=np.float32)
        self.assertGreater(
            dynamic_range_db(tone * envelope, SR), DEGRADED_DYNAMIC_RANGE_DB
        )

    def test_compressed_audio_is_below_agc_threshold(self):
        self.assertLess(dynamic_range_db(_tone() * 0.5, SR), AGC_DYNAMIC_RANGE_DB)

    def test_decaying_notes_are_not_mistaken_for_agc(self):
        """AGC をかけていない録音は、劣化録音ゲート(14 dB)も超える。

        m4-report 5.1 の clean/room/phone（16.3〜23.5 dB）に対応する側。
        """
        self.assertGreater(
            dynamic_range_db(_decaying_notes(), SR), DEGRADED_DYNAMIC_RANGE_DB
        )

    def test_agc_compressed_notes_fall_below_agc_threshold(self):
        """AGC をかけた同じ音源は AGC ゲート(10 dB)を下回る。

        これが `dynamics` の唯一の安全装置であり、この推定量の存在理由である。
        50 ms 非重複窓・線形パーセンタイルの推定量ではこの信号が 16 dB 前後に出て
        ゲートを通り抜けてしまう（M4 が -45.1 点と実測した強弱スコアが公開される）。
        """
        agc_audio = _apply_agc(_decaying_notes())
        self.assertLess(dynamic_range_db(agc_audio, SR), AGC_DYNAMIC_RANGE_DB)

    def test_silence_returns_zero(self):
        self.assertEqual(dynamic_range_db(np.zeros(SR, dtype=np.float32), SR), 0.0)

    def test_shorter_than_one_frame_returns_zero(self):
        self.assertEqual(dynamic_range_db(np.ones(10, dtype=np.float32), SR), 0.0)

    def test_empty_input_returns_zero(self):
        self.assertEqual(dynamic_range_db(np.zeros(0, dtype=np.float32), SR), 0.0)

    def test_length_not_a_whole_multiple_of_hop_ignores_the_remainder(self):
        """1フレームより長く、ホップの整数倍でない長さでの境界挙動を固定する。

        `n = 1 + (len - FRAME) // HOP` なので最後のフレームは必ず完全長になり、
        ホップに収まらない末尾は使われない。したがって末尾を切り落としても値は同じ。
        """
        audio = _decaying_notes()
        partial = audio[: FRAME + HOP + 100]
        truncated = audio[: FRAME + HOP]

        self.assertEqual(
            dynamic_range_db(partial, SR), dynamic_range_db(truncated, SR)
        )


if __name__ == "__main__":
    unittest.main()
