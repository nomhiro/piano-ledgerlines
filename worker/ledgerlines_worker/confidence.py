"""Fail-closed evaluation policy and confidence evidence.

The production worker currently does not preserve per-note transcription
probabilities and no teacher-calibrated policy artifact exists. This module
therefore records observable alignment evidence without pretending it is a
calibrated probability, and withholds scores that require calibration.
"""

from __future__ import annotations

from typing import Any

METRICS = ("pitch", "rhythm", "tempo", "dynamics", "pedal")

REASONS = {
    "UNCALIBRATED_MODEL": "教師評価データによる較正が完了していないため判定を保留しました。",
    "REFERENCE_ONLY_UNCALIBRATED": "録音条件に比較的頑健な参考値です。教師評価による較正前のため採点には使用しません。",
    "INSUFFICIENT_ALIGNMENT_EVIDENCE": "対応付けの根拠が不足しているため判定を保留しました。",
    "LOW_ALIGNMENT_CONFIDENCE": "較正済みの安全基準を満たす対応付け根拠がないため判定を保留しました。",
    "CALIBRATED_SCORE": "教師評価データで承認された較正基準を満たしています。",
    "NO_SCORE_DYNAMICS": "参照譜から強弱記号を抽出できていないため測定できません。",
    "NO_SCORE_PEDAL": "参照譜からペダル記号を抽出できていないため測定できません。",
}


def _evaluation(
    status: str,
    reason_code: str,
    confidence: float | None,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": status,
        "confidence": confidence,
        "reasonCode": reason_code,
        "reason": REASONS[reason_code],
        "evidence": evidence,
    }


def alignment_evidence(reference: dict, alignment: dict) -> tuple[dict, dict[int, dict]]:
    ref_notes = reference["notes"]
    ref_by_index = {int(note["index"]): note for note in ref_notes}
    ref_counts: dict[int, int] = {}
    matched_counts: dict[int, int] = {}

    for note in ref_notes:
        measure = int(note["measure"])
        ref_counts[measure] = ref_counts.get(measure, 0) + 1
    for ref_index, _ in alignment["pairs"]:
        note = ref_by_index.get(int(ref_index))
        if note is None:
            continue
        measure = int(note["measure"])
        matched_counts[measure] = matched_counts.get(measure, 0) + 1

    by_measure: dict[int, dict] = {}
    weighted_confidence = 0.0
    total_notes = 0
    for measure, ref_count in ref_counts.items():
        matched = matched_counts.get(measure, 0)
        match_rate = matched / ref_count if ref_count else 0.0
        anchor_quality = min(1.0, matched / 3.0)
        confidence = match_rate * anchor_quality
        by_measure[measure] = {
            "referenceNotes": ref_count,
            "matchedNotes": matched,
            "matchRate": round(match_rate, 4),
            "anchorQuality": round(anchor_quality, 4),
            "alignmentConfidence": round(confidence, 4),
        }
        weighted_confidence += confidence * ref_count
        total_notes += ref_count

    matched_total = len(alignment["pairs"])
    overall = {
        "referenceNotes": len(ref_notes),
        "matchedNotes": matched_total,
        "missedNotes": len(alignment.get("missed", [])),
        "extraNotes": len(alignment.get("extra", [])),
        "retakeNotes": len(alignment.get("retakes", [])),
        "unplayedNotes": len(alignment.get("unplayed", [])),
        "matchRate": round(matched_total / len(ref_notes), 4) if ref_notes else 0.0,
        "alignmentConfidence": round(weighted_confidence / total_notes, 4)
        if total_notes
        else None,
    }
    return overall, by_measure


def apply_fail_closed_policy(
    result: dict,
    reference: dict,
    alignment: dict,
    transcribed_note_count: int,
    calibration: dict | None = None,
) -> dict:
    """Withhold uncalibrated scores while retaining auditable reference data."""
    overall_evidence, by_measure = alignment_evidence(reference, alignment)
    diagnostics = {
        **overall_evidence,
        "transcribedNotes": transcribed_note_count,
        "calibrationStatus": "approved" if calibration else "missing",
        "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        "calibrationArtifactHash": calibration.get("artifactHash") if calibration else None,
    }
    raw_scores = {
        "overallScore": result.get("overallScore"),
        "metrics": dict(result.get("metrics", {})),
    }
    capabilities = reference.get("capabilities", {})
    alignment_confidence = overall_evidence["alignmentConfidence"]
    tempo_threshold = (
        (calibration.get("thresholds", {}).get("tempo") or {}).get("minimumConfidence")
        if calibration
        else None
    )
    tempo_is_scored = (
        raw_scores["metrics"].get("tempo") is not None
        and alignment_confidence is not None
        and tempo_threshold is not None
        and alignment_confidence >= tempo_threshold
    )
    if raw_scores["metrics"].get("tempo") is None:
        tempo_evaluation = _evaluation(
            "unavailable",
            "INSUFFICIENT_ALIGNMENT_EVIDENCE",
            alignment_confidence,
            diagnostics,
        )
    elif calibration is None:
        tempo_evaluation = _evaluation(
            "reference",
            "REFERENCE_ONLY_UNCALIBRATED",
            alignment_confidence,
            diagnostics,
        )
    elif tempo_is_scored:
        tempo_evaluation = _evaluation(
            "scored",
            "CALIBRATED_SCORE",
            alignment_confidence,
            diagnostics,
        )
    else:
        tempo_evaluation = _evaluation(
            "withheld",
            "LOW_ALIGNMENT_CONFIDENCE"
            if tempo_threshold is not None
            else "UNCALIBRATED_MODEL",
            alignment_confidence,
            diagnostics,
        )

    metric_evaluations = {
        "pitch": _evaluation(
            "withheld", "UNCALIBRATED_MODEL", None, diagnostics
        ),
        "rhythm": _evaluation(
            "withheld", "UNCALIBRATED_MODEL", None, diagnostics
        ),
        "tempo": tempo_evaluation,
        "dynamics": _evaluation(
            "withheld" if capabilities.get("dynamics") else "unavailable",
            "UNCALIBRATED_MODEL" if capabilities.get("dynamics") else "NO_SCORE_DYNAMICS",
            None,
            diagnostics,
        ),
        "pedal": _evaluation(
            "withheld" if capabilities.get("pedal") else "unavailable",
            "UNCALIBRATED_MODEL" if capabilities.get("pedal") else "NO_SCORE_PEDAL",
            None,
            diagnostics,
        ),
    }

    for measure_score in result["measureScores"]:
        measure = int(measure_score["measure"])
        evidence = by_measure.get(
            measure,
            {
                "referenceNotes": measure_score.get("refNotes", 0),
                "matchedNotes": 0,
                "matchRate": 0.0,
                "anchorQuality": 0.0,
                "alignmentConfidence": 0.0,
            },
        )
        tempo = measure_score["metrics"].get("tempo")
        measure_tempo_scored = (
            tempo is not None
            and tempo_threshold is not None
            and evidence["alignmentConfidence"] >= tempo_threshold
        )
        measure_tempo_reference = tempo is not None and calibration is None
        measure_score["scoreMeasure"] = measure
        measure_score["noteCount"] = measure_score.pop("refNotes", evidence["referenceNotes"])
        measure_score["confidence"] = evidence["alignmentConfidence"]
        measure_score["score"] = None
        measure_score["metrics"] = {
            "pitch": None,
            "rhythm": None,
            "tempo": tempo if measure_tempo_scored or measure_tempo_reference else None,
            "dynamics": None,
            "pedal": None,
        }
        measure_score["metricEvaluations"] = {
            key: (
                _evaluation(
                    (
                        "scored"
                        if measure_tempo_scored
                        else "reference"
                        if measure_tempo_reference
                        else "withheld"
                    ),
                    (
                        "CALIBRATED_SCORE"
                        if measure_tempo_scored
                        else "REFERENCE_ONLY_UNCALIBRATED"
                        if measure_tempo_reference
                        else "LOW_ALIGNMENT_CONFIDENCE"
                        if tempo_threshold is not None
                        else "UNCALIBRATED_MODEL"
                    ),
                    evidence["alignmentConfidence"],
                    evidence,
                )
                if key == "tempo" and tempo is not None
                else _evaluation(
                    (
                        "unavailable"
                        if key == "tempo"
                        or (key == "dynamics" and not capabilities.get("dynamics"))
                        or (key == "pedal" and not capabilities.get("pedal"))
                        else "withheld"
                    ),
                    (
                        (
                            "UNCALIBRATED_MODEL"
                            if capabilities.get("dynamics")
                            else "NO_SCORE_DYNAMICS"
                        )
                        if key == "dynamics"
                        else (
                            "UNCALIBRATED_MODEL"
                            if capabilities.get("pedal")
                            else "NO_SCORE_PEDAL"
                        )
                        if key == "pedal"
                        else "INSUFFICIENT_ALIGNMENT_EVIDENCE"
                        if key == "tempo"
                        else "UNCALIBRATED_MODEL"
                    ),
                    None,
                    evidence,
                )
            )
            for key in METRICS
        }

    result["overallScore"] = None
    result["metrics"] = {
        key: (
            raw_scores["metrics"].get(key)
            if key == "tempo" and tempo_evaluation["status"] in {"scored", "reference"}
            else None
        )
        for key in METRICS
    }
    result["metricConfidence"] = {
        key: alignment_confidence if key == "tempo" else None for key in METRICS
    }
    result["metricEvaluations"] = metric_evaluations
    result["metricsNAReason"] = {
        key: evaluation["reason"] for key, evaluation in metric_evaluations.items()
        if evaluation["status"] != "scored"
    }
    result["evaluation"] = {
        "status": "withheld",
        "confidence": None,
        "reasonCode": "UNCALIBRATED_MODEL",
        "reason": REASONS["UNCALIBRATED_MODEL"],
        "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
    }
    result["diagnostics"] = diagnostics
    return result
