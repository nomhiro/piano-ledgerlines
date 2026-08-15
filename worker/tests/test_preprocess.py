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
