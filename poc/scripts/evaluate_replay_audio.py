"""実録音での弾き直しに対するアライメント精度を評価する。

perturb_replay_audio.py が生成した実音声は、真の採譜結果と
1対1のインデックス対応を持たない（perturb_replay.py の MIDI 版と違い、
採譜モデルが検出する音符数・順序が実際の録音に依存するため）。

そこで evaluate_replay.py のような outIndex 完全一致ではなく、
「参照音符 gtIndex が最後に弾かれた時刻」を真値とし、
align.py が対応付けた採譜音符の実際の発音時刻がそれに近いかで判定する。

判定区分:
  correct … 最後のテイクの時刻に対応（正しい）
  stale   … 同じ音符の前のテイクの時刻に対応（実害は小さい）
  wrong   … どちらの時刻にも近くない対応（実害が大きい）
  missed  … 弾かれたのに対応が付かなかった
  spurious… 弾かれていない箇所に対応を張ってしまった
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from align import load_est

TOL_SEC = 0.3  # テイク間の間隔(>=1.2s)より十分小さく、採譜の発音時刻ずれよりは大きい


def build_expectations(truth_doc: dict) -> tuple[dict[int, float], dict[int, list[float]], set[int]]:
    """gtIndex -> 最後のテイクの時刻 / 全テイクの時刻列 / 弾かれた gtIndex 集合。"""
    by_src: dict[int, list[dict]] = {}
    for rec in truth_doc["notes"]:
        by_src.setdefault(rec["srcIndex"], []).append(rec)
    last: dict[int, float] = {}
    all_times: dict[int, list[float]] = {}
    for src, recs in by_src.items():
        recs.sort(key=lambda r: r["takeIndex"])
        all_times[src] = [r["start"] for r in recs]
        last[src] = recs[-1]["start"]
    return last, all_times, set(by_src)


def evaluate(reference: dict, truth_doc: dict, result: dict, est_notes: list[dict]) -> dict:
    last, all_times, played = build_expectations(truth_doc)
    est_by_index = {n["index"]: n for n in est_notes}
    pairs = {int(a): int(b) for a, b in result["pairs"]}

    gt_of_ref = {n["index"]: n["gtIndex"] for n in reference["notes"]}
    unplayed_refs = {r for r, g in gt_of_ref.items() if g not in played}
    played_refs = {r for r, g in gt_of_ref.items() if g in played}

    correct = stale = wrong = missed = 0
    for r in played_refs:
        g = gt_of_ref[r]
        e_idx = pairs.get(r)
        if e_idx is None:
            missed += 1
            continue
        est = est_by_index.get(e_idx)
        if est is None:
            missed += 1
            continue
        err_last = abs(est["start"] - last[g])
        if err_last <= TOL_SEC:
            correct += 1
        elif any(abs(est["start"] - t) <= TOL_SEC for t in all_times[g][:-1]):
            stale += 1
        else:
            wrong += 1

    spurious = sum(1 for r in unplayed_refs if r in pairs)

    n_played = len(played_refs)
    n_unplayed = len(unplayed_refs)
    return {
        "playedRefs": n_played,
        "unplayedRefs": n_unplayed,
        "correctRate": round(correct / n_played, 4) if n_played else 0.0,
        "staleRate": round(stale / n_played, 4) if n_played else 0.0,
        "wrongRate": round(wrong / n_played, 4) if n_played else 0.0,
        "missedRate": round(missed / n_played, 4) if n_played else 0.0,
        "spuriousRate": round(spurious / n_unplayed, 4) if n_unplayed else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--truth", type=Path, default=Path("out/replay_truth_audio"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--alignment", type=Path, default=Path("out/alignment"))
    ap.add_argument("--align-tag", default="")
    ap.add_argument("--out", type=Path, default=Path("out/replay_eval_audio.json"))
    args = ap.parse_args()

    asuffix = f".{args.align_tag}" if args.align_tag else ""
    rows = []
    for truth_path in sorted(args.truth.glob("*.truth.json")):
        truth_doc = json.loads(truth_path.read_text(encoding="utf-8"))
        name, cond = truth_doc["name"], truth_doc["condition"]
        align_path = args.alignment / f"{name}.{cond}{asuffix}.alignment.json"
        mid_path = args.transcribed / f"{name}.{cond}.mid"
        if not align_path.exists() or not mid_path.exists():
            continue
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        result = json.loads(align_path.read_text(encoding="utf-8"))
        est_notes = load_est(mid_path)
        row = {"name": name, "condition": cond, **evaluate(reference, truth_doc, result, est_notes)}
        rows.append(row)

    by_cond: dict[str, list[dict]] = {}
    for row in rows:
        by_cond.setdefault(row["condition"], []).append(row)

    keys = ("correctRate", "staleRate", "wrongRate", "missedRate", "spuriousRate")
    header = f"{'condition':<18} {'correct':>8} {'stale':>7} {'wrong':>7} {'missed':>7} {'spurious':>9}"
    print(header)
    print("-" * len(header))
    aggregate = {}
    for cond in sorted(by_cond):
        group = by_cond[cond]
        agg = {k: round(float(np.mean([g[k] for g in group])), 4) for k in keys}
        aggregate[cond] = agg
        print(
            f"{cond:<18} {agg['correctRate']:>8.4f} {agg['staleRate']:>7.4f} "
            f"{agg['wrongRate']:>7.4f} {agg['missedRate']:>7.4f} {agg['spuriousRate']:>9.4f}"
        )

    args.out.write_text(
        json.dumps({"perPiece": rows, "aggregate": aggregate}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
