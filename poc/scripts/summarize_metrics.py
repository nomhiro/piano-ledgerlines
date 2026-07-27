"""条件ごとの指標を集計して表示する（m4-report 用）。"""

from __future__ import annotations

import collections
import json
from pathlib import Path

import numpy as np

KEYS = ["overall", "pitch", "rhythm", "tempo", "dynamics", "pedal"]
ORDER = [
    "p_none",
    "clean",
    "room",
    "phone",
    "phone_agc",
    "p_drop05",
    "p_drop15",
    "p_add05",
    "p_add15",
    "p_jitter30",
    "p_jitter80",
    "p_tempo05",
    "p_tempo15",
    "p_flat50",
    "p_flat90",
    "p_nopedal",
]


def main() -> int:
    rows = json.loads(Path("out/metrics/summary.json").read_text(encoding="utf-8"))
    by = collections.defaultdict(list)
    for r in rows:
        by[r["condition"]].append(r)

    header = "cond".ljust(11) + "".join(k.rjust(10) for k in KEYS)
    print(header)
    print("-" * len(header))
    agg = {}
    for cond in ORDER:
        group = by.get(cond)
        if not group:
            continue
        vals = {
            k: float(np.mean([g[k] for g in group if g[k] is not None]))
            for k in KEYS
        }
        agg[cond] = {k: round(v, 1) for k, v in vals.items()}
        print(cond.ljust(11) + "".join(f"{vals[k]:>10.1f}" for k in KEYS))

    # 録音条件によるブレ（同じ演奏なのにスコアがどれだけ動くか）
    if all(c in agg for c in ("clean", "room", "phone", "phone_agc")):
        print("\n録音条件によるスコア変動（clean を基準にした差）")
        for cond in ("room", "phone", "phone_agc"):
            diff = {k: agg[cond][k] - agg["clean"][k] for k in KEYS}
            print(cond.ljust(11) + "".join(f"{diff[k]:>+10.1f}" for k in KEYS))

    Path("out/metrics/by_condition.json").write_text(
        json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
