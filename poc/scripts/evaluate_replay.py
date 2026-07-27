"""弾き直し・停止・部分練習を含む演奏に対するアライメント精度を測る。

perturb_replay.py が出力する正解対応（srcIndex / takeIndex）を使う。
時間軸が組み替わっているため、evaluate_alignment.py の
「mir_eval で ground truth と採譜結果を照合する」手法は使えない。

弾き直された音符は最後のテイクを正解とする。
弾かれなかった音符（部分練習・飛ばし）は評価対象外とし、
代わりに「弾いていないのに対応を張ってしまった率」を別に測る。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def build_truth(reference: dict, truth_notes: list[dict]) -> tuple[dict[int, int], set[int]]:
    """ref index -> 正解の演奏音符 index。弾かれなかった ref index の集合も返す。"""
    best: dict[int, dict] = {}
    for rec in truth_notes:
        cur = best.get(rec["srcIndex"])
        if cur is None or rec["takeIndex"] > cur["takeIndex"]:
            best[rec["srcIndex"]] = rec

    pairs: dict[int, int] = {}
    unplayed: set[int] = set()
    for note in reference["notes"]:
        rec = best.get(note["gtIndex"])
        if rec is None:
            unplayed.add(note["index"])
        else:
            pairs[note["index"]] = rec["outIndex"]
    return pairs, unplayed


def evaluate(reference: dict, truth_doc: dict, result: dict) -> dict:
    truth, unplayed = build_truth(reference, truth_doc["notes"])
    got = {int(a): int(b) for a, b in result["pairs"]}

    truth_set = set(truth.items())
    got_set = set(got.items())
    correct = truth_set & got_set

    played_refs = set(truth)
    got_refs = set(got)

    precision = len(correct) / len(got_set) if got_set else 0.0
    recall = len(correct) / len(truth_set) if truth_set else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    missed_set = set(result["missed"])
    false_missed = len(missed_set & played_refs) / len(played_refs) if played_refs else 0.0

    # 弾いていない箇所に対応を張ってしまった率（部分練習で致命的になる）
    spurious = len(got_refs & unplayed) / len(unplayed) if unplayed else 0.0

    # 弾き直しの箇所を「前のテイク」に張ってしまったか
    take_of: dict[int, int] = {r["outIndex"]: r["takeIndex"] for r in truth_doc["notes"]}
    src_of: dict[int, int] = {r["outIndex"]: r["srcIndex"] for r in truth_doc["notes"]}
    gt_of = {n["index"]: n["gtIndex"] for n in reference["notes"]}
    stale = 0
    wrong_place = 0
    for r, e in got.items():
        if r not in truth or truth[r] == e:
            continue
        if src_of.get(e) == gt_of.get(r):
            stale += 1  # 同じ音符の別テイクに張った（実害は小さい）
        else:
            wrong_place += 1  # まったく別の音符に張った（実害が大きい）
    wrong = stale + wrong_place

    return {
        "truthPairs": len(truth_set),
        "gotPairs": len(got_set),
        "correct": len(correct),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "falseMissedRate": round(false_missed, 4),
        "spuriousPairRate": round(spurious, 4),
        "unplayedRefs": len(unplayed),
        "staleTakeRate": round(stale / len(truth_set), 4) if truth_set else 0.0,
        "wrongPlaceRate": round(wrong_place / len(truth_set), 4) if truth_set else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--truth", type=Path, default=Path("out/replay_truth"))
    ap.add_argument("--alignment", type=Path, default=Path("out/alignment"))
    ap.add_argument("--out", type=Path, default=Path("out/replay_eval.json"))
    ap.add_argument("--align-tag", default="", help="align.py の --tag と合わせる")
    ap.add_argument("--tag", default="", help="出力ファイル名に付ける識別子")
    args = ap.parse_args()

    asuffix = f".{args.align_tag}" if args.align_tag else ""
    rows = []
    for truth_path in sorted(args.truth.glob("*.truth.json")):
        truth_doc = json.loads(truth_path.read_text(encoding="utf-8"))
        name, cond = truth_doc["name"], truth_doc["condition"]
        align_path = args.alignment / f"{name}.{cond}{asuffix}.alignment.json"
        if not align_path.exists():
            continue
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        result = json.loads(align_path.read_text(encoding="utf-8"))
        row = {"name": name, "condition": cond, **evaluate(reference, truth_doc, result)}
        rows.append(row)

    by_cond: dict[str, list[dict]] = {}
    for row in rows:
        by_cond.setdefault(row["condition"], []).append(row)

    keys = (
        "precision",
        "recall",
        "f1",
        "falseMissedRate",
        "spuriousPairRate",
        "staleTakeRate",
        "wrongPlaceRate",
    )
    header = (
        f"{'condition':<16} {'P':>7} {'R':>7} {'F1':>7} "
        f"{'falseMiss':>10} {'spurious':>9} {'stale':>7} {'wrongPl':>8}"
    )
    print(header)
    print("-" * len(header))
    aggregate = {}
    for cond in sorted(by_cond):
        group = by_cond[cond]
        agg = {k: round(float(np.mean([g[k] for g in group])), 4) for k in keys}
        aggregate[cond] = agg
        print(
            f"{cond:<16} {agg['precision']:>7.4f} {agg['recall']:>7.4f} {agg['f1']:>7.4f} "
            f"{agg['falseMissedRate']:>10.4f} {agg['spuriousPairRate']:>9.4f} "
            f"{agg['staleTakeRate']:>7.4f} {agg['wrongPlaceRate']:>8.4f}"
        )

    out = args.out
    if args.tag:
        out = out.with_name(out.stem + f".{args.tag}" + out.suffix)
    out.write_text(
        json.dumps({"perPiece": rows, "aggregate": aggregate}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
