"""S1: MusicXML -> versioned reference score with musical semantics."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

DYNAMIC_LEVEL = {
    "ppp": 0.0,
    "pp": 0.28,
    "p": 0.58,
    "mp": 0.86,
    "mf": 1.14,
    "f": 1.42,
    "ff": 1.72,
    "fff": 2.0,
}
TEMPO_EXPRESSION = re.compile(
    r"\b(rit(?:ardando)?|rall(?:entando)?|rubato|accel(?:erando)?|a\s+tempo)\b",
    re.IGNORECASE,
)
TEMPO_EXPRESSION_START = re.compile(
    r"\b(rit(?:ardando)?|rall(?:entando)?|rubato|accel(?:erando)?)\b",
    re.IGNORECASE,
)
TEMPO_EXPRESSION_RESET = re.compile(r"\ba\s+tempo\b", re.IGNORECASE)


def _offset(element, container) -> float:
    return float(element.getOffsetInHierarchy(container))


def _voice_id(note) -> str:
    from music21 import stream

    voice = note.getContextByClass(stream.Voice)
    return str(voice.id) if voice is not None and voice.id is not None else "1"


def _latest(events: list[tuple[float, Any]], position: float) -> Any | None:
    current = None
    for offset, value in events:
        if offset > position:
            break
        current = value
    return current


def _active_spanner(note, spanners: list) -> bool:
    return any(note in item.getSpannedElements() for item in spanners)


def _spanner_range(item, part) -> tuple[float, float] | None:
    elements = list(item.getSpannedElements())
    if not elements:
        return None
    offsets = [_offset(element, part) for element in elements]
    return min(offsets), max(offsets)


def _part_context(part) -> dict[str, Any]:
    from music21 import dynamics, expressions, spanner, tempo

    dynamic_events = sorted(
        (_offset(item, part), item.value)
        for item in part.recurse().getElementsByClass(dynamics.Dynamic)
    )
    text_events = sorted(
        (_offset(item, part), str(item.content).strip())
        for item in part.recurse().getElementsByClass(expressions.TextExpression)
        if str(item.content).strip()
    )
    tempo_events = sorted(
        (
            _offset(item, part),
            float(item.number) if isinstance(item, tempo.MetronomeMark) and item.number else None,
        )
        for item in part.recurse().getElementsByClass(tempo.TempoIndication)
    )
    wedges = []
    for item in part.recurse().getElementsByClass(dynamics.DynamicWedge):
        span = _spanner_range(item, part)
        if span is not None:
            wedges.append((*span, "cresc" if isinstance(item, dynamics.Crescendo) else "dim"))
    pedal_events = sorted(
        (
            _offset(item, part),
            str(getattr(item, "type", None) or getattr(item, "pedalType", None) or "mark"),
        )
        for item in part.recurse().getElementsByClass(expressions.PedalMark)
    )
    return {
        "dynamicEvents": dynamic_events,
        "textEvents": text_events,
        "tempoEvents": tempo_events,
        "wedges": wedges,
        "pedalEvents": pedal_events,
        "slurs": list(part.recurse().getElementsByClass(spanner.Slur)),
    }


def _note_semantics(note, part, part_index: int, context: dict[str, Any]) -> dict[str, Any]:
    from music21 import expressions

    start = _offset(note, part)
    dynamic_mark = _latest(context["dynamicEvents"], start)
    hairpin = next(
        (kind for span_start, span_end, kind in context["wedges"] if span_start <= start <= span_end),
        None,
    )
    articulations = sorted(
        {
            str(getattr(item, "name", None) or item.__class__.__name__).lower()
            for item in note.articulations
        }
    )
    pedal_mark = next(
        (kind for offset, kind in context["pedalEvents"] if abs(offset - start) < 1e-6),
        None,
    )
    return {
        "startBeat": start,
        "measure": int(note.measureNumber or 1),
        "voice": _voice_id(note),
        "staff": part_index + 1,
        "part": str(part.id or part_index + 1),
        "dynamicMark": dynamic_mark,
        "dynamicLevel": DYNAMIC_LEVEL.get(dynamic_mark) if dynamic_mark else None,
        "hairpin": hairpin,
        "articulations": articulations,
        "slurred": _active_spanner(note, context["slurs"]),
        "fermata": any(isinstance(item, expressions.Fermata) for item in note.expressions),
        "pedalMark": pedal_mark,
    }


def merge_ties(part, part_index: int, context: dict[str, Any]) -> list[dict]:
    """Merge tied notes while preserving voice/staff and score semantics."""
    merged: list[dict] = []
    pending: dict[tuple[str, int], dict] = {}
    for note in part.flatten().notes:
        pitches = note.pitches if note.isChord else [note.pitch]
        semantics = _note_semantics(note, part, part_index, context)
        voice = semantics["voice"]
        for pitch in pitches:
            key = (voice, int(pitch.midi))
            tie = note.tie.type if note.tie else None
            if tie in ("stop", "continue") and key in pending:
                pending[key]["durationBeats"] += float(note.duration.quarterLength)
                pending[key]["fermata"] = pending[key]["fermata"] or semantics["fermata"]
                if tie == "stop":
                    merged.append(pending.pop(key))
                continue
            record = {
                "pitch": int(pitch.midi),
                "durationBeats": float(note.duration.quarterLength),
                **semantics,
            }
            if tie in ("start", "continue"):
                pending[key] = record
            else:
                merged.append(record)
    merged.extend(pending.values())
    return merged


def _build_measures(score, contexts: list[dict], notes: list[dict], default_tempo: float) -> list[dict]:
    measures: dict[int, dict[str, Any]] = {}
    for part_index, part in enumerate(score.parts):
        context = contexts[part_index]
        for measure in part.getElementsByClass("Measure"):
            number = int(measure.number)
            record = measures.setdefault(
                number,
                {
                    "measure": number,
                    "scoreMeasure": number,
                    "startBeat": _offset(measure, part),
                    "beats": float(measure.barDuration.quarterLength),
                    "tempoBpm": default_tempo,
                    "tempoText": [],
                    "tempoExcluded": False,
                    "hasFermata": False,
                    "barline": None,
                    "dynamicMarks": [],
                    "hairpins": [],
                    "pedalMarks": [],
                    "voices": [],
                    "staves": [],
                    "pitchClasses": [],
                },
            )
            start = _offset(measure, part)
            end = start + float(measure.barDuration.quarterLength)
            texts = [value for offset, value in context["textEvents"] if start <= offset < end]
            tempos = [value for offset, value in context["tempoEvents"] if start <= offset < end and value]
            dynamics = [value for offset, value in context["dynamicEvents"] if start <= offset < end]
            pedals = [value for offset, value in context["pedalEvents"] if start <= offset < end]
            hairpins = [
                kind
                for span_start, span_end, kind in context["wedges"]
                if span_start < end and span_end >= start
            ]
            record["tempoText"] = sorted(set([*record["tempoText"], *texts]))
            record["dynamicMarks"] = sorted(set([*record["dynamicMarks"], *dynamics]))
            record["pedalMarks"] = sorted(set([*record["pedalMarks"], *pedals]))
            record["hairpins"] = sorted(set([*record["hairpins"], *hairpins]))
            if tempos:
                record["tempoBpm"] = tempos[-1]
            if measure.rightBarline is not None:
                record["barline"] = str(measure.rightBarline.type)

    for note in notes:
        record = measures[note["measure"]]
        record["hasFermata"] = record["hasFermata"] or note["fermata"]
        record["voices"] = sorted(set([*record["voices"], note["voice"]]))
        record["staves"] = sorted(set([*record["staves"], note["staff"]]))
        record["pitchClasses"] = sorted(set([*record["pitchClasses"], note["pitch"] % 12]))

    tempo_expression_active = False
    for measure_number in sorted(measures):
        record = measures[measure_number]
        starts_expression = any(
            TEMPO_EXPRESSION_START.search(text) for text in record["tempoText"]
        )
        resets_expression = any(
            TEMPO_EXPRESSION_RESET.search(text) for text in record["tempoText"]
        )
        tempo_expression_active = tempo_expression_active or starts_expression
        record["tempoExcluded"] = (
            record["hasFermata"]
            or tempo_expression_active
            or any(TEMPO_EXPRESSION.search(text) for text in record["tempoText"])
        )
        if resets_expression:
            tempo_expression_active = False
        record["hasDynamicMark"] = bool(record["dynamicMarks"] or record["hairpins"])
        record["hasArticulationMark"] = any(
            note["articulations"] or note["slurred"]
            for note in notes
            if note["measure"] == record["measure"]
        )
        record["hasPedalMark"] = bool(record["pedalMarks"])
    return [measures[key] for key in sorted(measures)]


def build_reference(musicxml_path: Path, tempo_bpm: float = 96.0) -> dict[str, Any]:
    """Build the versioned reference score consumed by alignment and metrics."""
    from music21 import converter

    score = converter.parse(str(musicxml_path))
    if not score.parts:
        raise ValueError("MusicXML does not contain any parts")
    ts_list = score.parts[0].recurse().getElementsByClass("TimeSignature")
    beats_per_measure = float(ts_list[0].numerator) if ts_list else 4.0
    time_signature = (
        f"{ts_list[0].numerator}/{ts_list[0].denominator}" if ts_list else "4/4"
    )

    contexts = [_part_context(part) for part in score.parts]
    notes: list[dict] = []
    for part_index, part in enumerate(score.parts):
        notes.extend(merge_ties(part, part_index, contexts[part_index]))
    notes.sort(key=lambda item: (item["startBeat"], item["pitch"], item["staff"], item["voice"]))

    measure_start: dict[int, float] = {}
    for part in score.parts:
        for measure in part.getElementsByClass("Measure"):
            number = int(measure.number)
            start = _offset(measure, part)
            measure_start[number] = min(measure_start.get(number, start), start)
    out_notes = []
    for index, item in enumerate(notes):
        out_notes.append(
            {
                **item,
                "index": index,
                "startBeat": round(item["startBeat"], 4),
                "durationBeats": round(item["durationBeats"], 4),
                "beatInMeasure": round(item["startBeat"] - measure_start[item["measure"]], 4),
            }
        )

    measures = _build_measures(score, contexts, out_notes, tempo_bpm)
    key_signature = None
    key_list = score.parts[0].recurse().getElementsByClass("KeySignature")
    if key_list:
        try:
            key_signature = key_list[0].asKey().tonicPitchNameWithCase
        except Exception:
            key_signature = None

    capabilities = {
        "dynamics": any(item["hasDynamicMark"] for item in measures),
        "tempoExpression": any(item["tempoExcluded"] for item in measures),
        "voices": any(len(item["voices"]) > 1 for item in measures) or len(score.parts) > 1,
        "articulation": any(item["hasArticulationMark"] for item in measures),
        "pedal": any(item["hasPedalMark"] for item in measures),
        "harmony": any(len(item["pitchClasses"]) >= 3 for item in measures),
    }
    return {
        "schemaVersion": "2.0",
        "estimatedTempo": tempo_bpm,
        "beatsPerMeasure": beats_per_measure,
        "timeSignature": time_signature,
        "keySignature": key_signature,
        "measureCount": max((item["measure"] for item in notes), default=0),
        "notes": out_notes,
        "measures": measures,
        "capabilities": capabilities,
        "source": "musicxml",
        "warnings": [],
    }
