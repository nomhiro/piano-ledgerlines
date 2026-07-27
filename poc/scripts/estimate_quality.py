"""録音そのものから品質を推定し、採譜精度を予測できるかを検証する。

指標のデッドゾーンは「その録音でどれだけ採譜が外れるか」に応じて決めたい。
しかし実運用では ground truth がないので、録音の音響特徴だけから
採譜精度を見積もれる必要がある。ここではその相関を確かめる。

同時に AGC の検出可能性も見る（AGC がかかると dynamics を N/A にする必要がある）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf

FRAME = 2048
HOP = 512
EPS = 1e-10


def frame_rms(audio: np.ndarray) -> np.ndarray:
    n = 1 + max(0, (len(audio) - FRAME) // HOP)
    return np.array(
        [float(np.sqrt(np.mean(audio[i * HOP : i * HOP + FRAME] ** 2) + EPS)) for i in range(n)]
    )


def features(audio: np.ndarray, sr: int) -> dict:
    rms = frame_rms(audio)
    db = 20 * np.log10(rms + EPS)
    quiet = float(np.percentile(db, 5))
    loud = float(np.percentile(db, 95))

    spec = np.abs(np.fft.rfft(audio[: sr * 60] * np.hanning(min(len(audio), sr * 60)), n=None))
    freqs = np.fft.rfftfreq(min(len(audio), sr * 60), 1 / sr)
    total = float(np.sum(spec) + EPS)
    hf = float(np.sum(spec[freqs >= 3500]) / total)
    lf = float(np.sum(spec[freqs <= 200]) / total)
    centroid = float(np.sum(freqs * spec) / total)

    # AGC は音量の起伏を圧縮するので、フレーム音量の分散が落ちる
    return {
        "noiseFloorDb": round(quiet, 2),
        "peakDb": round(loud, 2),
        "dynamicRangeDb": round(loud - quiet, 2),
        "rmsStdDb": round(float(np.std(db)), 3),
        "hfRatio": round(hf, 4),
        "lfRatio": round(lf, 4),
        "centroidHz": round(centroid, 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--eval", type=Path, default=Path("out/eval_transcription.json"))
    ap.add_argument("--out", type=Path, default=Path("out/quality.json"))
    ap.add_argument("--conditions", nargs="*", default=["clean", "room", "phone", "phone_agc"])
    args = ap.parse_args()

    scores = {}
    if args.eval.exists():
        data = json.loads(args.eval.read_text(encoding="utf-8"))
        for row in data.get("rows", []):
            scores[(row["piece"], row["condition"])] = row

    rows = []
    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    for piece in pieces:
        for cond in args.conditions:
            path = args.dataset / f"{piece['name']}.{cond}.wav"
            if not path.exists():
                continue
            audio, sr = sf.read(path, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            row = {"name": piece["name"], "condition": cond, **features(audio, sr)}
            ref = scores.get((piece["name"], cond))
            if ref:
                row["noteF1"] = ref.get("note_f1")
                row["velocityR"] = ref.get("velocity_r")
                row["pedalF1"] = (ref.get("pedal") or {}).get("f1")
            rows.append(row)

    print(f"{'piece':<9}{'cond':<11}{'range':>7}{'rmsStd':>8}{'hf':>8}{'noteF1':>8}{'velR':>7}")
    for r in rows:
        print(
            f"{r['name']:<9}{r['condition']:<11}{r['dynamicRangeDb']:>7.1f}{r['rmsStdDb']:>8.2f}"
            f"{r['hfRatio']:>8.4f}{r.get('noteF1', float('nan')):>8.3f}"
            f"{r.get('velocityR', float('nan')):>7.3f}"
        )

    keys = ["dynamicRangeDb", "rmsStdDb", "hfRatio", "lfRatio", "centroidHz", "noiseFloorDb"]
    valid = [r for r in rows if r.get("noteF1") is not None]
    correlations = {}
    if len(valid) >= 3:
        print("\ncorrelation with transcription accuracy:")
        for target in ("noteF1", "velocityR", "pedalF1"):
            y = np.array([r[target] for r in valid], dtype=float)
            correlations[target] = {}
            for k in keys:
                x = np.array([r[k] for r in valid], dtype=float)
                c = float(np.corrcoef(x, y)[0, 1]) if np.std(x) > 1e-9 else float("nan")
                correlations[target][k] = round(c, 3)
            print(f"  {target}: " + " ".join(f"{k}={correlations[target][k]:+.2f}" for k in keys))

    args.out.write_text(
        json.dumps({"rows": rows, "correlations": correlations}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
