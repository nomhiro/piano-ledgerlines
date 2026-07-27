"""スコアの測定ノイズと、差分として検出できる最小の変化量を求める。

同じ演奏を同じ条件で録り直したときにスコアがどれだけ揺れるかが σ。
「前回より 3 点良くなった」が意味を持つのは、その差が σ に対して十分大きいときだけ。

検出限界は t 検定の考え方で求める。1回ずつの比較なら差の標準偏差は √2σ なので、
95% の信頼で「改善した」と言える最小の差は約 2.77σ（= 1.96 * √2）。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

KEYS = ["overall", "pitch", "rhythm", "tempo", "dynamics", "pedal"]


def collect(metrics_dir: Path, pieces: list[str]) -> dict[tuple[str, str], list[dict]]:
    """(piece, level) -> スコアの列。"""
    out: dict[tuple[str, str], list[dict]] = {}
    for path in sorted(metrics_dir.glob("*.metrics.json")):
        m = re.match(r"(.+)\.st_([a-z]+)(\d+)\.metrics\.json$", path.name)
        if not m:
            continue
        name, level, _ = m.groups()
        if pieces and name not in pieces:
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        scores = {"overall": doc["overallScore"]}
        for k, v in doc["metrics"].items():
            if k in KEYS:
                scores[k] = v
        out.setdefault((name, level), []).append(scores)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metrics", type=Path, default=Path("out/metrics"))
    ap.add_argument("--out", type=Path, default=Path("out/stability/report.json"))
    ap.add_argument("--pieces", nargs="*", default=["piece00", "piece02"])
    args = ap.parse_args()

    groups = collect(args.metrics, args.pieces)
    if not groups:
        print("no metrics found. run compute_metrics.py for the st_* conditions first.")
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    print(f"{'piece':<9} {'level':<8} {'metric':<9} {'n':>3} {'mean':>7} {'sd':>6} "
          f"{'range':>7} {'MDD':>7}")
    print("-" * 62)
    for (name, level), samples in sorted(groups.items()):
        for key in KEYS:
            vals = np.array([s[key] for s in samples if s.get(key) is not None], dtype=float)
            if vals.size < 2:
                continue
            sd = float(vals.std(ddof=1))
            row = {
                "piece": name,
                "level": level,
                "metric": key,
                "n": int(vals.size),
                "mean": round(float(vals.mean()), 2),
                "sd": round(sd, 2),
                "range": round(float(vals.max() - vals.min()), 2),
                # 1回 vs 1回の比較で 95% 信頼できる最小検出差
                "minDetectableDiff": round(1.96 * np.sqrt(2) * sd, 2),
            }
            rows.append(row)
            print(
                f"{name:<9} {level:<8} {key:<9} {row['n']:>3} {row['mean']:>7.2f} "
                f"{row['sd']:>6.2f} {row['range']:>7.2f} {row['minDetectableDiff']:>7.2f}"
            )

    print("\n=== level ごとの集約（全曲平均） ===")
    print(f"{'level':<8} {'metric':<9} {'sd':>6} {'MDD(95%)':>9}")
    print("-" * 35)
    summary = {}
    for level in sorted({r["level"] for r in rows}):
        for key in KEYS:
            sds = [r["sd"] for r in rows if r["level"] == level and r["metric"] == key]
            if not sds:
                continue
            sd = float(np.mean(sds))
            mdd = 1.96 * np.sqrt(2) * sd
            summary[f"{level}|{key}"] = {"sd": round(sd, 2), "minDetectableDiff": round(mdd, 2)}
            print(f"{level:<8} {key:<9} {sd:>6.2f} {mdd:>9.2f}")

    args.out.write_text(
        json.dumps({"perGroup": rows, "summary": summary}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
