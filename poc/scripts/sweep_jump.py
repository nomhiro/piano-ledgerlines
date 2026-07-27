"""JUMP_PENALTY を掃引して、弾き直し対応と通常演奏の精度を両立する値を探す。

跳躍を許すとアライメントは弾き直しに強くなるが、
採譜ノイズで局所的に一致が悪くなった箇所でも跳んでしまう危険がある。
両方の条件で同時に評価し、通常演奏の精度を落とさない上限を決める。

コスト行列は penalty に依らないので一度だけ計算して使い回す。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import align as A  # noqa: E402
import evaluate_alignment as EA  # noqa: E402
import evaluate_replay as ER  # noqa: E402


def build_result(reference, est_notes, ref_ev, est_ev, est_pos, cost, penalty, window):
    runs = A.dtw_path_jump(cost, penalty) if penalty is not None else [A.dtw_path(cost)]
    used_est: set[int] = set()
    final: dict[int, int] = {}
    retakes: list[tuple[int, int]] = []
    covered: set[int] = set()
    for path in runs:
        covered.update(i for i, _ in path)
        for r, e in A._match_path(path, ref_ev, est_ev, est_pos, window, used_est):
            if r in final:
                retakes.append((r, final[r]))
            final[r] = e
    covered_notes = {n["index"] for i in covered for n in ref_ev[i]["members"]}
    ref_notes = reference["notes"]
    return {
        "pairs": sorted(final.items()),
        "missed": [
            n["index"] for n in ref_notes if n["index"] not in final and n["index"] in covered_notes
        ],
        "unplayed": [n["index"] for n in ref_notes if n["index"] not in covered_notes],
        "retakes": sorted(retakes),
        "extra": [],
        "takes": len(runs),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--truth", type=Path, default=Path("out/replay_truth"))
    ap.add_argument("--out", type=Path, default=Path("out/jump_sweep.json"))
    ap.add_argument("--window", type=float, default=1.0)
    ap.add_argument("--penalties", nargs="*", type=float, default=[3.0, 6.0, 10.0, 15.0, 25.0])
    ap.add_argument("--audio-conditions", nargs="*", default=["p_none", "clean", "room", "phone"])
    args = ap.parse_args()

    penalties: list = [None] + list(args.penalties)  # None = 現行の単調 DTW
    rows: list[dict] = []

    for ref_path in sorted(args.reference.glob("*.reference.json")):
        name = ref_path.name.split(".")[0]
        reference = json.loads(ref_path.read_text(encoding="utf-8"))
        ref_ev = A.group_events(reference["notes"], "startBeat", A.REF_GROUP_BEATS)

        conditions = [(c, "audio") for c in args.audio_conditions]
        conditions += [
            (p.name.split(".")[1], "replay") for p in sorted(args.truth.glob(f"{name}.*.truth.json"))
        ]

        gt = EA.load_notes(args.dataset / f"{name}.ref.mid")
        for cond, kind in conditions:
            mid = args.transcribed / f"{name}.{cond}.mid"
            if not mid.exists():
                continue
            est_notes = A.load_est(mid)
            est_ev = A.group_events(est_notes, "start", A.EST_GROUP_SEC)
            est_pos = [ev["pos"] for ev in est_ev]
            cost = A.cost_matrix(ref_ev, est_ev)

            if kind == "audio":
                est_pm = EA.load_notes(mid)
                truth = EA.truth_pairs(gt, est_pm, reference["notes"], 0.05)
            else:
                truth_doc = json.loads(
                    (args.truth / f"{name}.{cond}.truth.json").read_text(encoding="utf-8")
                )

            for pen in penalties:
                res = build_result(
                    reference, est_notes, ref_ev, est_ev, est_pos, cost, pen, args.window
                )
                if kind == "audio":
                    got = {(int(a), int(b)) for a, b in res["pairs"]}
                    correct = truth & got
                    p = len(correct) / len(got) if got else 0.0
                    r = len(correct) / len(truth) if truth else 0.0
                    metrics = {"f1": 2 * p * r / (p + r) if p + r else 0.0}
                else:
                    metrics = {"f1": ER.evaluate(reference, truth_doc, res)["f1"]}
                rows.append(
                    {
                        "name": name,
                        "condition": cond,
                        "kind": kind,
                        "penalty": pen if pen is not None else "strict",
                        "f1": round(metrics["f1"], 4),
                        "takes": res["takes"],
                    }
                )
            print(f"{name}/{cond} done", flush=True)

    # penalty × condition の平均を表にする
    conds = sorted({r["condition"] for r in rows}, key=lambda c: (not c.startswith("r_"), c))
    pens = [r if r is not None else "strict" for r in penalties]
    print()
    header = f"{'penalty':>8} " + " ".join(f"{c:>15}" for c in conds)
    print(header)
    print("-" * len(header))
    table = {}
    for pen in pens:
        cells = []
        for c in conds:
            vals = [r["f1"] for r in rows if r["penalty"] == pen and r["condition"] == c]
            v = float(np.mean(vals)) if vals else float("nan")
            table[(str(pen), c)] = round(v, 4)
            cells.append(f"{v:>15.4f}")
        print(f"{str(pen):>8} " + " ".join(cells))

    args.out.write_text(
        json.dumps({"rows": rows, "table": {f"{k[0]}|{k[1]}": v for k, v in table.items()}},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
