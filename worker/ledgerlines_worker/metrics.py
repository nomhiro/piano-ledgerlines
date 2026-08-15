"""S4: 指標算出（5指標: pitch/rhythm/tempo/dynamics/pedal）。

poc/scripts/compute_metrics.py の compute() をそのまま移植。
articulation は M4 の検証で offset が信頼できないと判明したため実装しない
（poc/scripts/analyze_offsets.py / analyze_legato.py 参照）。
"""

from __future__ import annotations

import numpy as np
import pretty_midi

from .scoring_constants import DEAD_RHYTHM, DEAD_RHYTHM_DEGRADED, WEIGHTS

W_MISS = 1.0
W_EXTRA = 0.7
TAU_PITCH = 0.15
TAU_RHYTHM = 0.12
DEAD_TEMPO = 0.03
TAU_TEMPO = 0.10
DEAD_DYN = 0.06
TAU_DYN = 0.18
DYN_SCALE_MIN = 0.5
DYN_SCALE_MAX = 2.0
RANGE_PENALTY = 0.30
DEAD_PEDAL = 0.10
TAU_PEDAL = 0.30
SYNC_WEIGHT = 0.3


def decay(e: float, tau: float, k: float = 1.0) -> float:
    return 100.0 * float(np.exp(-((max(e, 0.0) / tau) ** k)))


def estimate_beat_map(
    pairs: list[tuple[int, int]], ref_notes: list[dict], est_notes: list[dict]
) -> tuple[np.ndarray, np.ndarray]:
    """matched 音符から (拍, 秒) の対応列を作る。同一拍は中央値でまとめる。"""
    buckets: dict[float, list[float]] = {}
    for r_idx, e_idx in pairs:
        buckets.setdefault(ref_notes[r_idx]["startBeat"], []).append(est_notes[e_idx]["start"])
    beats = np.array(sorted(buckets), dtype=float)
    secs = np.array([float(np.median(buckets[b])) for b in beats], dtype=float)
    secs = np.maximum.accumulate(secs)
    return beats, secs


def sec_to_beat(beats: np.ndarray, secs: np.ndarray, t: float) -> float:
    if len(beats) < 2:
        return float("nan")
    return float(np.interp(t, secs, beats))


def measure_seconds(beats: np.ndarray, secs: np.ndarray, beat: float) -> float:
    if len(beats) < 2:
        return float("nan")
    return float(np.interp(beat, beats, secs))


def pedal_intervals(pm: pretty_midi.PrettyMIDI, threshold: int = 64) -> list[tuple[float, float]]:
    events = sorted(
        (cc.time, cc.value) for inst in pm.instruments for cc in inst.control_changes if cc.number == 64
    )
    intervals: list[tuple[float, float]] = []
    start = None
    for t, v in events:
        if v >= threshold and start is None:
            start = t
        elif v < threshold and start is not None:
            intervals.append((start, t))
            start = None
    if start is not None:
        intervals.append((start, events[-1][0] if events else start))
    return intervals


def pedal_ratio(intervals: list[tuple[float, float]], t0: float, t1: float) -> float:
    if t1 <= t0:
        return 0.0
    covered = sum(max(0.0, min(e, t1) - max(s, t0)) for s, e in intervals)
    return covered / (t1 - t0)


def sync_error(notes: list[dict], pair_by_ref: dict[int, int], est_notes: list[dict]) -> float:
    """同一拍に記譜された音符群の発音のばらつき（縦の揃い）。"""
    groups: dict[float, list[float]] = {}
    for n in notes:
        if n["index"] in pair_by_ref:
            groups.setdefault(n["startBeat"], []).append(est_notes[pair_by_ref[n["index"]]]["start"])
    spreads = [max(v) - min(v) for v in groups.values() if len(v) >= 2]
    return float(np.mean(spreads)) if spreads else 0.0


def compute(
    reference: dict,
    est_notes: list[dict],
    alignment: dict,
    est_pedal: list[tuple[float, float]],
    ref_pedal: list[tuple[float, float]],
    degraded: bool = False,
) -> dict:
    ref_notes = reference["notes"]
    dead_rhythm = DEAD_RHYTHM_DEGRADED if degraded else DEAD_RHYTHM
    bpm_measure = reference["beatsPerMeasure"]
    pairs = [(int(a), int(b)) for a, b in alignment["pairs"]]
    beats, secs = estimate_beat_map(pairs, ref_notes, est_notes)

    ref_by_measure: dict[int, list[dict]] = {}
    for n in ref_notes:
        ref_by_measure.setdefault(n["measure"], []).append(n)
    pair_by_ref = dict(pairs)
    missed_by_measure: dict[int, int] = {}
    for r_idx in alignment["missed"]:
        m = ref_notes[r_idx]["measure"]
        missed_by_measure[m] = missed_by_measure.get(m, 0) + 1
    extra_by_measure: dict[int, int] = {}
    for e_idx in alignment["extra"]:
        b = sec_to_beat(beats, secs, est_notes[e_idx]["start"])
        if np.isnan(b):
            continue
        m = int(b // bpm_measure) + 1
        extra_by_measure[m] = extra_by_measure.get(m, 0) + 1

    target, actual, dyn_measures = [], [], []
    for m, notes in sorted(ref_by_measure.items()):
        eligible = [
            n for n in notes
            if n["index"] in pair_by_ref and n.get("dynamicLevel") is not None
        ]
        if not eligible:
            continue
        target.append(float(np.mean([n["dynamicLevel"] / 2 for n in eligible])))
        actual.append(
            float(np.mean([est_notes[pair_by_ref[n["index"]]]["velocity"] for n in eligible]))
            / 127.0
        )
        dyn_measures.append(m)
    if len(actual) >= 2 and np.std(actual) > 1e-6:
        a, b = np.polyfit(actual, target, 1)
        a = float(np.clip(a, DYN_SCALE_MIN, DYN_SCALE_MAX))
        b = float(np.mean(target) - a * np.mean(actual))
    else:
        a, b = 1.0, 0.0
    dyn_hat = {m: a * v + b for m, v in zip(dyn_measures, actual)}
    dyn_target = dict(zip(dyn_measures, target))

    range_penalty = 0.0
    if len(dyn_hat) >= 2:
        span_ref = max(target) - min(target)
        span_est = max(dyn_hat.values()) - min(dyn_hat.values())
        if span_ref > 1e-6:
            range_penalty = RANGE_PENALTY * max(0.0, 1.0 - span_est / span_ref)

    measure_scores = []
    for m, notes in sorted(ref_by_measure.items()):
        n_ref = len(notes)
        e_pitch = (
            W_MISS * missed_by_measure.get(m, 0) + W_EXTRA * extra_by_measure.get(m, 0)
        ) / n_ref
        scores: dict[str, float | None] = {"pitch": decay(e_pitch, TAU_PITCH)}

        deltas = []
        for n in notes:
            if n["index"] not in pair_by_ref:
                continue
            b_perf = sec_to_beat(beats, secs, est_notes[pair_by_ref[n["index"]]]["start"])
            if not np.isnan(b_perf):
                deltas.append(b_perf - n["startBeat"])
        if len(deltas) >= 2:
            d = np.array(deltas) - float(np.median(deltas))
            e_rhythm = float(np.sqrt(np.mean(np.maximum(0.0, np.abs(d) - dead_rhythm) ** 2)))
            e_sync = sync_error(notes, pair_by_ref, est_notes)
            scores["rhythm"] = decay(e_rhythm + SYNC_WEIGHT * e_sync, TAU_RHYTHM, 2.0)
        else:
            scores["rhythm"] = None

        t0 = measure_seconds(beats, secs, (m - 1) * bpm_measure)
        t1 = measure_seconds(beats, secs, m * bpm_measure)
        tempo_m = bpm_measure * 60.0 / (t1 - t0) if t1 > t0 else float("nan")

        dyn = None
        if m in dyn_hat:
            e_dyn = abs(dyn_hat[m] - dyn_target[m]) + range_penalty
            dyn = decay(max(0.0, e_dyn - DEAD_DYN), TAU_DYN)
        scores["dynamics"] = dyn

        if not np.isnan(t0) and not np.isnan(t1) and t1 > t0:
            e_ped = abs(pedal_ratio(est_pedal, t0, t1) - pedal_ratio(ref_pedal, t0, t1))
            scores["pedal"] = decay(max(0.0, e_ped - DEAD_PEDAL), TAU_PEDAL)
        else:
            scores["pedal"] = None

        measure_scores.append(
            {"measure": m, "refNotes": n_ref, "tempoBpm": tempo_m, "metrics": scores}
        )

    excluded_tempo = {
        int(measure["measure"])
        for measure in reference.get("measures", [])
        if measure.get("tempoExcluded")
    }
    tempos = [
        ms["tempoBpm"]
        for ms in measure_scores
        if not np.isnan(ms["tempoBpm"]) and ms["measure"] not in excluded_tempo
    ]
    t_base = float(np.median(tempos)) if tempos else float("nan")
    for ms in measure_scores:
        t = ms["tempoBpm"]
        if ms["measure"] in excluded_tempo or np.isnan(t) or np.isnan(t_base) or t <= 0:
            ms["metrics"]["tempo"] = None
        else:
            ms["metrics"]["tempo"] = decay(
                max(0.0, abs(np.log(t / t_base)) - DEAD_TEMPO), TAU_TEMPO, 2.0
            )
        ms["tempoBpm"] = None if np.isnan(t) else round(t, 2)

    overall_metrics = {}
    for key in WEIGHTS:
        num = sum(
            ms["metrics"][key] * ms["refNotes"]
            for ms in measure_scores
            if ms["metrics"][key] is not None
        )
        den = sum(ms["refNotes"] for ms in measure_scores if ms["metrics"][key] is not None)
        overall_metrics[key] = round(num / den, 2) if den else None

    active = {k: w for k, w in WEIGHTS.items() if overall_metrics[k] is not None}
    total_w = sum(active.values())
    overall = (
        round(sum(overall_metrics[k] * w for k, w in active.items()) / total_w, 2)
        if total_w
        else None
    )

    for ms in measure_scores:
        act = {k: w for k, w in WEIGHTS.items() if ms["metrics"][k] is not None}
        tw = sum(act.values())
        ms["score"] = (
            round(sum(ms["metrics"][k] * w for k, w in act.items()) / tw, 2) if tw else None
        )
        ms["metrics"] = {
            k: (round(v, 2) if v is not None else None) for k, v in ms["metrics"].items()
        }

    return {
        "overallScore": overall,
        "metrics": overall_metrics,
        "baseTempo": None if np.isnan(t_base) else round(t_base, 2),
        "measureScores": measure_scores,
    }


def load_est(path) -> tuple[list[dict], list[tuple[float, float]]]:
    pm = pretty_midi.PrettyMIDI(str(path))
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    return (
        [
            {
                "index": i,
                "pitch": int(n.pitch),
                "start": float(n.start),
                "end": float(n.end),
                "velocity": int(n.velocity),
            }
            for i, n in enumerate(notes)
        ],
        pedal_intervals(pm),
    )
