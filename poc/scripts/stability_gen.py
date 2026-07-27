"""同じ演奏を繰り返し録音したときのスコアのばらつき（測定ノイズ）を測る。

「前回より良くなった」を言うには、スコアの差が測定ノイズより大きい必要がある。
実録音を何度も取ることはできないので、劣化条件の乱数を振り直して代用する。

2段階で測る。
  noise   … 同じ部屋・同じマイク位置で、雑音の実現値だけが変わる
  session … 日が変わって部屋の響き・マイク位置・環境音が少し変わる

session の σ が「前回のテイクと比べられる分解能」を決める。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parent))

import degrade as D  # noqa: E402

SR = 16000


def make_variant(clean: np.ndarray, seed: int, level: str) -> np.ndarray:
    rng = np.random.default_rng(seed)
    D.RNG = rng  # degrade.py の各関数はモジュール変数の RNG を使う

    if level == "noise":
        rt60, direct_ratio, snr = 0.45, 0.55, 34.0
    else:
        # 日をまたいだ録音のばらつき。部屋の響き・マイク位置・環境音が変わる
        rt60 = 0.45 * float(rng.uniform(0.85, 1.15))
        direct_ratio = 0.55 * float(rng.uniform(0.8, 1.25))
        snr = 34.0 + float(rng.uniform(-3.0, 3.0))

    length = int(rt60 * 1.6 * SR)
    t = np.arange(length) / SR
    decay = np.exp(-6.9078 * t / rt60)
    ir = rng.standard_normal(length) * decay
    b, a = signal.butter(2, 6000 / (SR / 2), btype="low")
    ir = signal.lfilter(b, a, ir)
    ir[: int(0.008 * SR)] = 0.0
    ir /= np.abs(ir).max() + 1e-12
    direct = np.zeros(length)
    direct[0] = 1.0
    ir = direct + direct_ratio * ir

    room = signal.fftconvolve(clean, ir)[: len(clean)]
    return D.normalize(D.add_noise(room, snr_db=snr))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--out", type=Path, default=Path("out/stability"))
    ap.add_argument("--pieces", nargs="*", default=["piece00", "piece02"])
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--levels", nargs="*", default=["noise", "session"])
    ap.add_argument("--base-seed", type=int, default=771000)
    ap.add_argument("--skip-generate", action="store_true")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    conditions = []
    for name in args.pieces:
        clean, sr = sf.read(args.dataset / f"{name}.clean.wav", dtype="float32")
        assert sr == SR
        for level in args.levels:
            for k in range(args.trials):
                cond = f"st_{level}{k}"
                conditions.append(cond)
                path = args.dataset / f"{name}.{cond}.wav"
                if args.skip_generate and path.exists():
                    continue
                y = make_variant(clean, args.base_seed + k * 97 + (0 if level == "noise" else 5000), level)
                sf.write(path, y, SR, subtype="PCM_16")
        print(f"{name}: generated {len(args.levels) * args.trials} variants", flush=True)

    conditions = sorted(set(conditions))
    (args.out / "conditions.json").write_text(
        json.dumps({"pieces": args.pieces, "conditions": conditions}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\nconditions: " + " ".join(conditions))
    print("\n次に実行する:")
    print(f"  python scripts/transcribe.py --conditions {' '.join(conditions)} "
          f"--pieces {' '.join(args.pieces)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
