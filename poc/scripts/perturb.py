"""既知の摂動を与えた「演奏」を作り、指標が期待どおり反応するかを検証する。

採譜を経由せず ground truth MIDI を直接いじることで、
「採譜誤差」と「指標そのものの挙動」を切り分ける。

perturbation=none は完璧な演奏に相当し、本来なら全指標が満点に近くなるはず。
ここで満点にならない分が、参照譜の量子化など指標側の系統誤差である。
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np
import pretty_midi

RNG_SEED = 20260725


def clone(pm: pretty_midi.PrettyMIDI) -> pretty_midi.PrettyMIDI:
    return copy.deepcopy(pm)


def drop_notes(pm: pretty_midi.PrettyMIDI, rate: float, rng: np.random.Generator) -> None:
    for inst in pm.instruments:
        keep = rng.random(len(inst.notes)) >= rate
        inst.notes = [n for n, k in zip(inst.notes, keep) if k]


def add_notes(pm: pretty_midi.PrettyMIDI, rate: float, rng: np.random.Generator) -> None:
    """隣接半音の余分な音を混ぜる（打ち間違いの模擬）。"""
    for inst in pm.instruments:
        extras = []
        for n in inst.notes:
            if rng.random() < rate:
                shift = int(rng.choice([-1, 1]))
                extras.append(
                    pretty_midi.Note(
                        velocity=max(1, n.velocity - 10),
                        pitch=int(np.clip(n.pitch + shift, 21, 108)),
                        start=n.start,
                        end=n.end,
                    )
                )
        inst.notes.extend(extras)
        inst.notes.sort(key=lambda x: (x.start, x.pitch))


def jitter_timing(pm: pretty_midi.PrettyMIDI, sigma: float, rng: np.random.Generator) -> None:
    """発音時刻に独立なゆらぎを与える（リズムの乱れ）。"""
    for inst in pm.instruments:
        for n in inst.notes:
            d = float(rng.normal(0.0, sigma))
            n.start = max(0.0, n.start + d)
            n.end = max(n.start + 0.02, n.end + d)


def drift_tempo(pm: pretty_midi.PrettyMIDI, amount: float, period: float = 8.0) -> None:
    """緩やかなテンポの波を与える（走る／もたる）。"""
    end = pm.get_end_time()
    if end <= 0:
        return

    def warp(t: float) -> float:
        return t + amount * period / (2 * np.pi) * np.sin(2 * np.pi * t / period)

    for inst in pm.instruments:
        for n in inst.notes:
            s, e = warp(n.start), warp(n.end)
            n.start, n.end = max(0.0, s), max(s + 0.02, e)
        for cc in inst.control_changes:
            cc.time = max(0.0, warp(cc.time))


def flatten_dynamics(pm: pretty_midi.PrettyMIDI, strength: float) -> None:
    """強弱の幅を潰す（初中級者に多い課題）。"""
    vels = [n.velocity for inst in pm.instruments for n in inst.notes]
    if not vels:
        return
    mean = float(np.mean(vels))
    for inst in pm.instruments:
        for n in inst.notes:
            n.velocity = int(np.clip(round(mean + (n.velocity - mean) * (1 - strength)), 1, 127))


def drop_pedal(pm: pretty_midi.PrettyMIDI, rate: float, rng: np.random.Generator) -> None:
    for inst in pm.instruments:
        inst.control_changes = [
            cc for cc in inst.control_changes if cc.number != 64 or rng.random() >= rate
        ]


PERTURBATIONS: dict[str, tuple[str, float]] = {
    "none": ("none", 0.0),
    "drop05": ("drop", 0.05),
    "drop15": ("drop", 0.15),
    "add05": ("add", 0.05),
    "add15": ("add", 0.15),
    "jitter30": ("jitter", 0.030),
    "jitter80": ("jitter", 0.080),
    "tempo05": ("tempo", 0.05),
    "tempo15": ("tempo", 0.15),
    "flat50": ("flat", 0.5),
    "flat90": ("flat", 0.9),
    "nopedal": ("pedal", 1.0),
}


def apply(pm: pretty_midi.PrettyMIDI, kind: str, amount: float, rng) -> None:
    if kind == "drop":
        drop_notes(pm, amount, rng)
    elif kind == "add":
        add_notes(pm, amount, rng)
    elif kind == "jitter":
        jitter_timing(pm, amount, rng)
    elif kind == "tempo":
        drift_tempo(pm, amount)
    elif kind == "flat":
        flatten_dynamics(pm, amount)
    elif kind == "pedal":
        drop_pedal(pm, amount, rng)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--out", type=Path, default=Path("out/transcribed"))
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    for piece in pieces:
        base = pretty_midi.PrettyMIDI(str(args.dataset / f"{piece['name']}.ref.mid"))
        for label, (kind, amount) in PERTURBATIONS.items():
            rng = np.random.default_rng(RNG_SEED)
            pm = clone(base)
            apply(pm, kind, amount, rng)
            pm.write(str(args.out / f"{piece['name']}.p_{label}.mid"))
        print(f"{piece['name']}: {len(PERTURBATIONS)} perturbations written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
