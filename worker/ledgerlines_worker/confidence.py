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
    "INSUFFICIENT_ALIGNMENT_EVIDENCE": "対応付けの根拠が不足しているため判定を保留しました。",
    "NO_SCORE_DYNAMICS": "参照譜から強弱記号を抽出できていないため測定できません。",
    "NO_SCORE_PEDAL": "参照譜からペダル記号を抽出できていないため測定できません。",
    "PITCH_FORMULA_UNVALIDATED": "音程の指標式が採譜ノイズに影響されることが判明しているため、式の検証が完了するまで判定を保留します。",
    "AGC_DETECTED": "自動ゲイン制御がかかった録音のため、強弱を測定できません。",
    "PEDAL_REFERENCE_NOT_REGENERATED": "この曲の参照譜にペダル位置が含まれていないため測定できません。楽譜を再登録すると測定できます。",
    # reference.py の _pedal_intervals_beats が区間を空で返す原因は複数あり
    # （pedalType が sustain 以外／getSpannedElements が空／end<=start の退化区間）、
    # どの原因でもここに来る。「サステイン以外」と断定すると後者2つで嘘になるため、
    # 3パターンいずれでも真になる「区間を抽出できなかった」という結果面の表現にする。
    "NO_MEASURABLE_PEDAL_INTERVALS": "この楽譜のペダル記号から測定可能なサステイン区間を抽出できなかったため測定対象外です。",
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
        "extraPlayedNotes": len(alignment.get("extraPlayed", alignment.get("extra", []))),
        "extraNoiseNotes": len(alignment.get("extraNoise", [])),
        "extraNoiseByReason": alignment.get(
            "extraNoiseByReason", {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}
        ),
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
    pedal_reference_regenerated: bool = False,
) -> dict:
    """指標ごとに、実測された頑健性に基づいて採点可否を決める。

    m4-report.md 5章の実測（clean 基準の差）:
        tempo -2.7/-1.9/-3.2、pedal -4.5/-5.0、dynamics -5.7/-9.0/-45.1(AGC)、
        rhythm -11.8/-6.6/-14.7、pitch -37.7/-37.6/-50.0
    pitch のみ式が採譜ノイズに支配されるため保留する（段3で対応）。

    ペダル関連の2つのフラグは別の状態を表す。混同すると誤った案内文が出る:
        pedal_reference_regenerated  参照譜が `pedalIntervalsBeats` キーを持つか
                                     （＝新形式で再生成済みか）
        pedal_reference_available    そのキーに sustain 区間が1つ以上あるか
    キーが無いなら「楽譜を再登録すれば測定できる」が正しく、キーはあるのに区間が
    空なら（楽譜のペダル記号が全て sostenuto/soft）再登録しても結果は変わらない。
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
                # capabilities.pedal は種別を絞らず hasPedalMark だけを見るが、区間
                # 抽出は sustain のみを拾う。よって「記号はあるが sustain が無い」と
                # 「参照譜が旧形式」の2状態が両方ここに来る。再登録で直るのは後者だけ。
                if pedal_reference_regenerated:
                    return "unavailable", "NO_MEASURABLE_PEDAL_INTERVALS"
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

        def measure_decision(key: str) -> tuple[str, str]:
            """この小節における (status, reasonCode)。

            take レベルの判定 (`decisions[key]`) が原則そのまま通る。唯一の例外は
            take レベルが `scored`（この指標は全体としては採点可能）なのに、この
            小節自身には素点が無い場合——その場合だけ「この小節の対応付け根拠が
            不足している」という小節固有の理由に置き換える。take レベルが
            `withheld`/`unavailable` のとき（例: pitch や below_floor、AGC、参照
            ペダル未登録）はその具体的な理由をそのまま伝播する。汎用理由で
            上書きすると、同じ応答内で take レベルより曖昧、あるいは矛盾した
            status になってしまう（例: below_floor 時に一部の小節だけ
            unavailable になる）。
            """
            take_status, take_reason = decisions[key]
            if take_status == "scored" and measure_metrics.get(key) is None:
                return "unavailable", "INSUFFICIENT_ALIGNMENT_EVIDENCE"
            return take_status, take_reason

        measure_decisions = {key: measure_decision(key) for key in METRICS}
        measure_score["metricEvaluations"] = {
            key: _evaluation(
                status,
                reason_code,
                evidence["alignmentConfidence"] if status == "scored" else None,
                evidence,
            )
            for key, (status, reason_code) in measure_decisions.items()
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
        # overallScore が出ない理由は「対応付けが不成立」「保留された指標がある」
        # 「全指標が測定対象外（total_weight == 0）」の3通りある。今は pitch が必ず
        # withheld なので2番目しか起こらないが、`has_withheld` を見ずに pitch の理由へ
        # 倒すと、段3 で pitch が scored になったあと3番目の経路が「pitch の式が未検証」
        # という事実でない理由を返すようになる。decisions は METRICS 順なので、
        # 代表として最初に該当した指標の具体的な理由を採る。
        if below_floor:
            reason_code = "ALIGNMENT_BELOW_FLOOR"
        else:
            preferred = "withheld" if has_withheld else "unavailable"
            reason_code = next(
                (code for status, code in decisions.values() if status == preferred),
                "INSUFFICIENT_ALIGNMENT_EVIDENCE",
            )
        result["evaluation"] = {
            "status": "withheld",
            "confidence": alignment_confidence,
            "reasonCode": reason_code,
            "reason": REASONS[reason_code],
            "calibrationVersion": calibration.get("calibrationVersion") if calibration else None,
        }
    result["diagnostics"] = diagnostics
    return result
