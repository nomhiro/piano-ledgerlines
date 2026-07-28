"""S1: MusicXML → 参照譜(reference.json)。

poc/scripts/musicxml_reference.py の build_reference() をそのまま移植。
タイ結合は実装済み。繰り返し記号（リピート／ダ・カーポ）の展開は
m5-prep-report.md 4.4 で指摘された既知の未実装課題（本ワーカーでは非対応）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def merge_ties(part) -> list[dict]:
    """タイで結ばれた音符を1つの音符（開始拍・合計長）に統合する。"""
    merged: list[dict] = []
    pending: dict[int, dict] = {}
    for n in part.flatten().notes:
        pitches = n.pitches if n.isChord else [n.pitch]
        for p in pitches:
            key = p.midi
            tie = n.tie.type if n.tie else None
            if tie in ("stop", "continue") and key in pending:
                pending[key]["durationBeats"] += float(n.duration.quarterLength)
                if tie == "stop":
                    merged.append(pending.pop(key))
            else:
                rec = {
                    "pitch": key,
                    "startBeat": float(n.offset),
                    "durationBeats": float(n.duration.quarterLength),
                    "measure": n.measureNumber,
                }
                if tie in ("start", "continue"):
                    pending[key] = rec
                else:
                    merged.append(rec)
    merged.extend(pending.values())
    return merged


def build_reference(musicxml_path: Path, tempo_bpm: float = 96.0) -> dict[str, Any]:
    """MusicXML ファイルから reference.json 相当の辞書を作る。"""
    from music21 import converter

    score = converter.parse(str(musicxml_path))
    ts_list = score.parts[0].recurse().getElementsByClass("TimeSignature")
    beats_per_measure = float(ts_list[0].numerator) if ts_list else 4.0
    time_signature = f"{ts_list[0].numerator}/{ts_list[0].denominator}" if ts_list else "4/4"

    notes: list[dict] = []
    for part in score.parts:
        notes.extend(merge_ties(part))
    notes.sort(key=lambda n: (n["startBeat"], n["pitch"]))

    measure_start_beat: dict[int, float] = {}
    for n in notes:
        m = n["measure"]
        measure_start_beat.setdefault(m, n["startBeat"])
        measure_start_beat[m] = min(measure_start_beat[m], n["startBeat"])

    out_notes = []
    for i, n in enumerate(notes):
        beat_in_measure = n["startBeat"] - measure_start_beat[n["measure"]]
        out_notes.append(
            {
                "index": i,
                "pitch": n["pitch"],
                "startBeat": round(n["startBeat"], 4),
                "durationBeats": round(n["durationBeats"], 4),
                "measure": n["measure"],
                "beatInMeasure": round(beat_in_measure, 4),
                # 強弱記号からの抽出は未実装（m5-prep-report.md 4.4）。暫定固定値。
                "dynamicLevel": 2,
            }
        )

    key_signature = None
    key_list = score.parts[0].recurse().getElementsByClass("KeySignature")
    if key_list:
        try:
            key_signature = key_list[0].asKey().tonicPitchNameWithCase
        except Exception:
            key_signature = None

    return {
        "estimatedTempo": tempo_bpm,
        "beatsPerMeasure": beats_per_measure,
        "timeSignature": time_signature,
        "keySignature": key_signature,
        "measureCount": max((n["measure"] for n in notes), default=0),
        "notes": out_notes,
        "source": "musicxml",
        "warnings": [],
    }
