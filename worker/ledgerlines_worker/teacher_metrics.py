"""Uncalibrated teacher-facing observations.

These features are deliberately not scores. They provide auditable inputs for
teacher annotation and future calibration without publishing musical judgments.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any


def extract_candidate_observations(
    reference: dict,
    est_notes: list[dict],
    alignment: dict,
    measure_scores: list[dict],
) -> dict[str, Any]:
    ref_by_index = {int(note["index"]): note for note in reference["notes"]}
    est_by_index = {int(note.get("index", index)): note for index, note in enumerate(est_notes)}
    velocities: dict[tuple[int, int, str], list[int]] = defaultdict(list)
    for ref_index, est_index in alignment["pairs"]:
        ref = ref_by_index.get(int(ref_index))
        estimated = est_by_index.get(int(est_index))
        if ref is None or estimated is None:
            continue
        key = (int(ref["measure"]), int(ref.get("staff", 1)), str(ref.get("voice", "1")))
        velocities[key].append(int(estimated["velocity"]))

    voice_balance = []
    for (measure, staff, voice), values in sorted(velocities.items()):
        voice_balance.append(
            {
                "measure": measure,
                "staff": staff,
                "voice": voice,
                "matchedNotes": len(values),
                "meanVelocity": round(sum(values) / len(values), 2),
            }
        )

    measure_lookup = {
        int(item["measure"]): item for item in reference.get("measures", [])
    }
    tempo_observations = []
    for item in measure_scores:
        measure = int(item["measure"])
        semantics = measure_lookup.get(measure, {})
        tempo_observations.append(
            {
                "measure": measure,
                "tempoBpm": item.get("tempoBpm"),
                "excludedFromMechanicalPenalty": bool(semantics.get("tempoExcluded")),
                "tempoText": semantics.get("tempoText", []),
                "fermata": bool(semantics.get("hasFermata")),
            }
        )

    dynamics = [
        {
            "measure": int(item["measure"]),
            "marks": item.get("dynamicMarks", []),
            "hairpins": item.get("hairpins", []),
        }
        for item in reference.get("measures", [])
        if item.get("dynamicMarks") or item.get("hairpins")
    ]
    pedal_harmony = [
        {
            "measure": int(item["measure"]),
            "pedalMarks": item.get("pedalMarks", []),
            "pitchClasses": item.get("pitchClasses", []),
        }
        for item in reference.get("measures", [])
        if item.get("pedalMarks") or item.get("pitchClasses")
    ]
    return {
        "status": "uncalibrated",
        "publishable": False,
        "tempoExpression": tempo_observations,
        "voiceBalance": voice_balance,
        "dynamics": dynamics,
        "pedalHarmony": pedal_harmony,
    }
