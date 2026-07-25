"""ByteDance の高解像度ピアノ採譜モデルを CPU で走らせ、速度と出力を記録する。

M4 の最重要検証項目は「CPU 推論が実用速度に収まるか」（architecture.md Q1）。
GPU が必須になると解析ワーカーのコストが約 2.5 倍になり、
アーキテクチャとコスト試算の前提が変わる。

RTF (real-time factor) = 処理時間 / 音声長 を条件ごとに記録する。
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

SR = 16000


def load_audio(path: Path) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32")
    assert sr == SR, f"expected {SR} Hz, got {sr}"
    return audio


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--out", type=Path, default=Path("out/transcribed"))
    ap.add_argument(
        "--conditions", nargs="+", default=["clean", "room", "phone", "phone_agc"]
    )
    ap.add_argument("--threads", type=int, default=0, help="0 なら torch の既定値")
    ap.add_argument("--checkpoint", type=Path, default=None)
    args = ap.parse_args()

    if args.threads > 0:
        torch.set_num_threads(args.threads)

    from piano_transcription_inference import PianoTranscription

    args.out.mkdir(parents=True, exist_ok=True)
    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))

    load_start = time.perf_counter()
    kwargs = {"device": "cpu"}
    if args.checkpoint:
        kwargs["checkpoint_path"] = str(args.checkpoint)
    model = PianoTranscription(**kwargs)
    load_sec = time.perf_counter() - load_start

    env = {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "threads": torch.get_num_threads(),
        "processor": platform.processor(),
        "model_load_sec": round(load_sec, 2),
    }
    print(f"env: {env}")

    results = []
    for piece in pieces:
        for cond in args.conditions:
            wav = args.dataset / f"{piece['name']}.{cond}.wav"
            if not wav.exists():
                continue
            audio = load_audio(wav)
            duration = len(audio) / SR
            midi_out = args.out / f"{piece['name']}.{cond}.mid"

            t0 = time.perf_counter()
            model.transcribe(audio, str(midi_out))
            elapsed = time.perf_counter() - t0

            row = {
                "piece": piece["name"],
                "condition": cond,
                "duration_sec": round(duration, 2),
                "elapsed_sec": round(elapsed, 2),
                "rtf": round(elapsed / duration, 3),
                "midi": str(midi_out),
            }
            results.append(row)
            print(
                f"{piece['name']:>8} {cond:<10} {duration:6.1f}s -> "
                f"{elapsed:6.1f}s  RTF={row['rtf']:.2f}"
            )

    summary = {"env": env, "results": results}
    if results:
        rtfs = [r["rtf"] for r in results]
        summary["rtf_mean"] = round(float(np.mean(rtfs)), 3)
        summary["rtf_max"] = round(float(np.max(rtfs)), 3)
        print(f"\nRTF mean={summary['rtf_mean']} max={summary['rtf_max']}")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "timing.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
