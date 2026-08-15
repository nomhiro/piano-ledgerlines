"""Fail-closed evaluation policy and confidence evidence.

The production worker currently does not preserve per-note transcription
probabilities and no teacher-calibrated policy artifact exists. This module
therefore records observable alignment evidence without pretending it is a
calibrated probability, and withholds scores that require calibration.
"""

from __future__ import annotations

from typing import Any

from .scoring_constants import AGC_DYNAMIC_RANGE_DB, WEIGHTS

METRICS = ("pitch", "rhythm", "tempo", "dynamics", "pedal")

MIN_MATCH_RATE = 0.30  # spec 4.7。別曲の音声を弾いた場合の安全網

REASONS = {
    "UNCALIBRATED_MODEL": "教師評価データによる較正が完了していないため判定を保留しました。",
    "REFERENCE_ONLY_UNCALIBRATED": "録音条件に比較的頑健な参考値です。教師評価による較正前のため採点には使用しません。",
    "INSUFFICIENT_ALIGNMENT_EVIDENCE": "対応付けの根拠が不足しているため判定を保留しました。",
    "LOW_ALIGNMENT_CONFIDENCE": "較正済みの安全基準を満たす対応付け根拠がないため判定を保留しました。",
    "CALIBRATED_SCORE": "教師評価データで承認された較正基準を満たしています。",
    "NO_SCORE_DYNAMICS": "参照譜から強弱記号を抽出できていないため測定できません。",
    "NO_SCORE_PEDAL": "参照譜からペダル記号を抽出できていないため測定できません。",
    "PITCH_FORMULA_UNVALIDATED": "音程の指標式が採譜ノイズに影響されることが判明しているため、式の検証が完了するまで判定を保留します。",
    "AGC_DETECTED": "自動ゲイン制御がかかった録音のため、強弱を測定できません。",
    "PEDAL_REFERENCE_NOT_REGENERATED": "この曲の参照譜にペダル位置が含まれていないため測定できません。楽譜を再登録すると測定できます。",
    "ALIGNMENT_BELOW_FLOOR": "楽譜と演奏の対応付けが成立していないため採点できません。別の曲の録音でないかご確認ください。",
    "ROBUSTNESS_VALIDATED": "録音条件に対する頑健性が実測で確認されている指標です。",
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
    *,
    dynamic_range_db: float | None = None,
    pedal_reference_available: bool = False,
) -> dict:
    """指標ごとに、実測された頑健性に基づいて採点可否を決める。

    m4-report.md 5章の実測（clean 基準の差）:
        tempo -2.7/-1.9/-3.2、pedal -4.5/-5.0、dynamics -5.7/-9.0/-45.1(AGC)、
        rhythm -11.8/-6.6/-14.7、pitch -37.7/-37.6/-50.0
    pitch のみ式が採譜ノイズに支配されるため保留する（段3で対応）。
    """
    overall_evidence, by_measure = alignment_evidence(reference, alignment)
    diagnostics = {
        **overall_evidence,
        "transcribedNotes": transcribed_note_count,
        "dynamicRangeDb": dynamic_range_db,
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
    below_floor = overall_evidence["matchRate"] < MIN_MATCH_RATE
    agc = dynamic_range_db is not None and dynamic_range_db < AGC_DYNAMIC_RANGE_DB

    def decide(key: str) -> tuple[str, str]:
        """(status, reasonCode) を返す。

        指標固有の判定を先に行う。参照譜にペダル位置が無いことや AGC がかかっている
        ことは素点の有無に関わらず確定しており、「対応付け根拠不足」より具体的な
        理由だからである。pitch も同様に、素点の有無に関わらず式が未検証である。
        """
        if below_floor:
            return "withheld", "ALIGNMENT_BELOW_FLOOR"
        if key == "pitch":
            # pitch は capability の前提を持たないため、採点されない理由は常に
            # 「式が未検証」である。素点が None でも unavailable にしない。
            # これにより overallScore が段2 で数値になることを防ぐ。
            return "withheld", "PITCH_FORMULA_UNVALIDATED"
        if key == "dynamics":
            if not capabilities.get("dynamics"):
                return "unavailable", "NO_SCORE_DYNAMICS"
            if agc:
                return "unavailable", "AGC_DETECTED"
        if key == "pedal":
            if not capabilities.get("pedal"):
                return "unavailable", "NO_SCORE_PEDAL"
            if not pedal_reference_available:
                return "unavailable", "PEDAL_REFERENCE_NOT_REGENERATED"
        if raw_scores["metrics"].get(key) is None:
            return "unavailable", "INSUFFICIENT_ALIGNMENT_EVIDENCE"
        return "scored", "ROBUSTNESS_VALIDATED"

    decisions = {key: decide(key) for key in METRICS}
    metric_evaluations = {
        key: _evaluation(
            status,
            reason_code,
            alignment_confidence if status == "scored" else None,
            diagnostics,
        )
        for key, (status, reason_code) in decisions.items()
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
        measure_metrics = dict(measure_score["metrics"])
        measure_score["scoreMeasure"] = measure
        measure_score["noteCount"] = measure_score.pop("refNotes", evidence["referenceNotes"])
        measure_score["confidence"] = evidence["alignmentConfidence"]
        measure_score["metrics"] = {
            key: (measure_metrics.get(key) if decisions[key][0] == "scored" else None)
            for key in METRICS
        }
        measure_score["metricEvaluations"] = {
            key: _evaluation(
                decisions[key][0] if measure_metrics.get(key) is not None else "unavailable",
                decisions[key][1]
                if measure_metrics.get(key) is not None
                else "INSUFFICIENT_ALIGNMENT_EVIDENCE",
                evidence["alignmentConfidence"] if decisions[key][0] == "scored" else None,
                evidence,
            )
            for key in METRICS
        }
        scored = {
            key: weight
            for key, weight in WEIGHTS.items()
            if measure_score["metrics"][key] is not None
        }
        total = sum(scored.values())
        measure_score["score"] = (
            round(
                sum(measure_score["metrics"][key] * weight for key, weight in scored.items())
                / total,
                2,
            )
            if total
            else None
        )

    result["metrics"] = {
        key: (raw_scores["metrics"].get(key) if decisions[key][0] == "scored" else None)
        for key in METRICS
    }
    has_withheld = any(status == "withheld" for status, _ in decisions.values())
    scored_weights = {
        key: weight
        for key, weight in WEIGHTS.items()
        if decisions[key][0] == "scored" and result["metrics"][key] is not None
    }
    total_weight = sum(scored_weights.values())
    result["overallScore"] = (
        None
        if has_withheld or not total_weight
        else round(
            sum(result["metrics"][key] * weight for key, weight in scored_weights.items())
            / total_weight,
            2,
        )
    )
    result["metricConfidence"] = {
        key: (alignment_confidence if decisions[key][0] == "scored" else None)
        for key in METRICS
    }
    result["metricEvaluations"] = metric_evaluations
    result["metricsNAReason"] = {
        key: evaluation["reason"]
        for key, evaluation in metric_evaluations.items()
        if evaluation["status"] != "scored"
    }
    result["alignmentBelowFloor"] = below_floor
    if result["overallScore"] is not None:
        result["evaluation"] = {
            "status": "scored",
            "confidence": alignment_confidence,
            "reasonCode": "ROBUSTNESS_VALIDATED",
            "reason": REASONS["ROBUSTNESS_VALIDATED"],
            "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        }
    else:
        reason_code = "ALIGNMENT_BELOW_FLOOR" if below_floor else "PITCH_FORMULA_UNVALIDATED"
        result["evaluation"] = {
            "status": "withheld",
            "confidence": alignment_confidence,
            "reasonCode": reason_code,
            "reason": REASONS[reason_code],
            "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        }
    result["diagnostics"] = diagnostics
    return result
