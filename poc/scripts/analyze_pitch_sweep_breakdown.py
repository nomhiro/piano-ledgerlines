"""フェーズ1（脚1）の5条件について、align() の内訳を5曲合計で集計する。

`sweep_pitch_tau.py` / `out/metrics/pitch-sweep.json` は `{condition, pitch}` しか
保持しないため、結果文書 §6 の matched/missed/unplayed/extraPlayed/extraNoise と
`extraNoiseByReason` はコミットされたスクリプトの出力から再現できない、コンテナ内での
アドホック解析の産物だった。本スクリプトはその集計をコミットされた形で再現する
（設計 §9.5 のレビュー指摘への対応）。式・分類ロジックは再実装せず worker の
`align()` をそのまま呼ぶ。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.align import align  # noqa: E402
from ledgerlines_worker.metrics import load_est  # noqa: E402

CONDITIONS = ["none", "drop05", "drop15", "add05", "add15"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    args = ap.parse_args()

    totals = {c: {"ref": 0, "matched": 0, "missed": 0, "unplayed": 0, "extraPlayed": 0,
                   "extraNoise": 0, "estNotes": 0,
                   "reasons": {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}}
              for c in CONDITIONS}

    for ref_path in sorted(args.reference.glob("*.reference.json")):
        reference = json.loads(ref_path.read_text(encoding="utf-8"))
        name = ref_path.name.split(".")[0]
        for cond in CONDITIONS:
            mid = args.transcribed / f"{name}.p_{cond}.mid"
            if not mid.exists():
                continue
            est_notes, est_pedal = load_est(mid)
            r = align(reference, est_notes, mode="jump", est_pedal=est_pedal)
            t = totals[cond]
            t["ref"] += len(reference["notes"])
            t["matched"] += len(r["pairs"])
            t["missed"] += len(r["missed"])
            t["unplayed"] += len(r["unplayed"])
            t["extraPlayed"] += len(r["extraPlayed"])
            t["extraNoise"] += len(r["extraNoise"])
            t["estNotes"] += len(est_notes)
            for reason, n in r["extraNoiseByReason"].items():
                t["reasons"][reason] += n

    print(f"{'condition':<8} {'ref':>6} {'matched':>8} {'missed':>7} {'unplayed':>9} "
          f"{'extraPlayed':>11} {'extraNoise':>10} {'estNotes':>9}")
    for cond in CONDITIONS:
        t = totals[cond]
        print(f"{cond:<8} {t['ref']:>6} {t['matched']:>8} {t['missed']:>7} {t['unplayed']:>9} "
              f"{t['extraPlayed']:>11} {t['extraNoise']:>10} {t['estNotes']:>9}")
    print()
    for cond in ("add05", "add15"):
        print(cond, totals[cond]["reasons"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
