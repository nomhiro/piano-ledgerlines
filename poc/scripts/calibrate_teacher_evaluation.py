"""Create a calibration artifact from technical truth and teacher annotations."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

METRICS = ("pitch", "rhythm", "tempo", "dynamics", "pedal")
MIN_CALIBRATION_RECORDS = 20
MIN_TEST_RECORDS = 20


def _rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=values.__getitem__)
    ranks = [0.0] * len(values)
    index = 0
    while index < len(order):
        end = index + 1
        while end < len(order) and values[order[end]] == values[order[index]]:
            end += 1
        rank = (index + end - 1) / 2 + 1
        for position in order[index:end]:
            ranks[position] = rank
        index = end
    return ranks


def spearman(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or len(left) < 2:
        return float("nan")
    x, y = _rank(left), _rank(right)
    mx, my = sum(x) / len(x), sum(y) / len(y)
    numerator = sum((a - mx) * (b - my) for a, b in zip(x, y))
    denominator = math.sqrt(
        sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y)
    )
    return numerator / denominator if denominator else float("nan")


def worst_measure_agreement(system: list[int], teachers: list[list[int]]) -> float:
    if not teachers:
        return 0.0
    system_set = set(system[:5])
    return sum(len(system_set & set(items[:5])) / 5 for items in teachers) / len(teachers)


def choose_safe_threshold(rows: list[tuple[float, bool]], max_false_pass_rate: float = 0.05):
    if not rows or len({safe for _, safe in rows}) < 2:
        return None
    candidates = sorted({confidence for confidence, _ in rows})
    valid: list[tuple[int, float, float]] = []
    for threshold in candidates:
        passed = [safe for confidence, safe in rows if confidence >= threshold]
        if not passed:
            continue
        false_pass = sum(not safe for safe in passed) / len(passed)
        if false_pass <= max_false_pass_rate:
            valid.append((len(passed), threshold, false_pass))
    if not valid:
        return None
    coverage, threshold, false_pass = max(valid, key=lambda item: (item[0], -item[1]))
    return {
        "minimumConfidence": threshold,
        "calibrationCoverage": coverage / len(rows),
        "falsePassRate": false_pass,
    }


def evaluate_threshold(rows: list[tuple[float, bool]], threshold: dict | None) -> dict:
    if threshold is None or len(rows) < MIN_TEST_RECORDS or len({safe for _, safe in rows}) < 2:
        return {
            "passed": False,
            "records": len(rows),
            "falsePassRate": None,
            "falseWithholdRate": None,
        }
    minimum = float(threshold["minimumConfidence"])
    unsafe = [confidence for confidence, safe in rows if not safe]
    safe = [confidence for confidence, is_safe in rows if is_safe]
    false_pass = sum(confidence >= minimum for confidence in unsafe) / len(unsafe)
    false_withhold = sum(confidence < minimum for confidence in safe) / len(safe)
    return {
        "passed": false_pass <= 0.05,
        "records": len(rows),
        "falsePassRate": false_pass,
        "falseWithholdRate": false_withhold,
    }


def validate_dataset(dataset: dict[str, Any]) -> None:
    if dataset.get("schemaVersion") != "1.0":
        raise ValueError("unsupported dataset schema")
    assignments: dict[tuple[str, str], str] = {}
    take_ids: set[str] = set()
    for record in dataset.get("records", []):
        key = (record["performerId"], record["pieceId"])
        if record["takeId"] in take_ids:
            raise ValueError("duplicate takeId")
        take_ids.add(record["takeId"])
        assigned = assignments.setdefault(key, record["split"])
        if assigned != record["split"]:
            raise ValueError("performer/piece leakage across dataset splits")
        if record["annotationStatus"] == "annotated":
            teachers = {item["teacherId"] for item in record["teacherAnnotations"]}
            if len(teachers) < 3:
                raise ValueError(f"{record['takeId']} needs at least three independent teachers")
            if record["technicalGroundTruth"] is None:
                raise ValueError(f"{record['takeId']} lacks technical ground truth")
            if any(len(item["worstMeasures"]) != 5 for item in record["teacherAnnotations"]):
                raise ValueError(f"{record['takeId']} needs exactly five worst measures per teacher")


def calibrate(dataset: dict[str, Any]) -> dict[str, Any]:
    validate_dataset(dataset)
    annotated = [
        record for record in dataset["records"] if record["annotationStatus"] == "annotated"
    ]
    calibration = [record for record in annotated if record["split"] == "calibration"]
    test = [record for record in annotated if record["split"] == "test"]
    thresholds = {}
    confidence_validation = {}
    for metric in METRICS:
        calibration_rows = []
        for record in calibration:
            confidence = record.get("metricConfidence", {}).get(metric)
            safe = (record.get("technicalGroundTruth") or {}).get("safeToScore", {}).get(metric)
            if confidence is not None and safe is not None:
                calibration_rows.append((float(confidence), bool(safe)))
        thresholds[metric] = (
            choose_safe_threshold(calibration_rows)
            if len(calibration_rows) >= MIN_CALIBRATION_RECORDS
            else None
        )
        test_rows = []
        for record in test:
            confidence = record.get("metricConfidence", {}).get(metric)
            safe = (record.get("technicalGroundTruth") or {}).get("safeToScore", {}).get(metric)
            if confidence is not None and safe is not None:
                test_rows.append((float(confidence), bool(safe)))
        confidence_validation[metric] = evaluate_threshold(test_rows, thresholds[metric])

    system_ranks, teacher_ranks = [], []
    worst_scores = []
    target_passed = False
    for record in test:
        system_scored = record.get("systemEvaluationStatus") != "withheld"
        if system_scored and record.get("systemOverallRank") is not None:
            system_ranks.append(float(record["systemOverallRank"]))
            teacher_ranks.append(
                sum(float(item["overallRank"]) for item in record["teacherAnnotations"])
                / len(record["teacherAnnotations"])
            )
        if system_scored and record.get("systemWorstMeasures"):
            worst_scores.append(
                worst_measure_agreement(
                    record["systemWorstMeasures"],
                    [item["worstMeasures"] for item in record["teacherAnnotations"]],
                )
            )
        if record["takeId"] == "take_980da1b96a3d4bcc9c6c":
            target_passed = (
                record.get("expectedEvaluationStatus") == "withheld"
                and record.get("systemEvaluationStatus") == "withheld"
            )

    rho = spearman(system_ranks, teacher_ranks)
    worst = sum(worst_scores) / len(worst_scores) if worst_scores else 0.0
    gates_passed = (
        len(calibration) >= MIN_CALIBRATION_RECORDS
        and len(test) >= MIN_TEST_RECORDS
        and not math.isnan(rho)
        and rho >= 0.7
        and worst >= 0.7
        and target_passed
        and all(value is not None for value in thresholds.values())
        and all(value["passed"] for value in confidence_validation.values())
    )
    canonical = json.dumps(dataset, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return {
        "schemaVersion": "1.0",
        "calibrationVersion": f"{dataset['datasetVersion']}-calibration-v1",
        "datasetHash": hashlib.sha256(canonical).hexdigest(),
        "approved": gates_passed,
        "thresholds": thresholds,
        "releaseGates": {
            "passed": gates_passed,
            "testRecords": len(test),
            "calibrationRecords": len(calibration),
            "teacherRankSpearman": None if math.isnan(rho) else round(rho, 4),
            "worstFiveAgreement": round(worst, 4),
            "targetTakeRegression": target_passed,
            "confidenceValidation": confidence_validation,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    artifact = calibrate(dataset)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(artifact["releaseGates"], ensure_ascii=False))
    return 0 if artifact["approved"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
