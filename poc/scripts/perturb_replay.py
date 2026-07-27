"""弾き直し・停止・部分練習を含む「演奏」を作る。

M4 では扱えなかった、初中級者の練習に頻出する状況を模擬する。
  ・retry   … 途中で間違えて数小節戻り、弾き直す
  ・stop    … 途中で長く止まる（考え込む・楽譜を見る）
  ・partial … 曲の一部だけを練習する

M4 の perturb.py と違い、時間軸を組み替えるため
「採譜結果と ground truth を照合して正解対応を作る」手法が使えない。
そこで、出力音符が ground truth のどの音符に由来するかを直接記録する。

  srcIndex  … ground truth の音符インデックス
  takeIndex … 何回目の演奏か（弾き直すと 1, 2, ... と増える）

弾き直した箇所は「最後のテイク」を採点対象とみなす。
練習では直近の演奏を評価するのが自然であるため。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pretty_midi

RNG_SEED = 20260727
PAUSE_RETRY = 1.2  # 弾き直す前の間（秒）
PAUSE_STOP = 3.0  # 停止の長さ（秒）


def load_gt(path: Path) -> tuple[list[pretty_midi.Note], list[pretty_midi.ControlChange]]:
    pm = pretty_midi.PrettyMIDI(str(path))
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    ccs = sorted(
        (cc for inst in pm.instruments for cc in inst.control_changes if cc.number == 64),
        key=lambda c: c.time,
    )
    return notes, ccs


def measure_times(reference: dict) -> dict[int, float]:
    """小節番号 -> その小節の最初の音符の実時刻。"""
    out: dict[int, float] = {}
    for note in reference["notes"]:
        m = note["measure"]
        t = note["gtStart"]
        if m not in out or t < out[m]:
            out[m] = t
    return out


def make_plan(kind: str, mtimes: dict[int, float], total: float, rng) -> list[dict]:
    """演奏プラン = 「ground truth のこの区間をこの順で弾く」の列。

    各要素は {"src": (開始秒, 終了秒), "pause": 直前に空ける秒数}。
    """
    measures = sorted(mtimes)
    if len(measures) < 8:
        return [{"src": (0.0, total), "pause": 0.0}]

    def t(m: int) -> float:
        return mtimes[measures[min(max(m, 0), len(measures) - 1)]]

    n = len(measures)
    if kind == "none":
        return [{"src": (0.0, total), "pause": 0.0}]

    if kind == "retry1":
        # 中盤でつまずき、2小節戻ってやり直す
        stumble, back = int(n * 0.55), 2
        return [
            {"src": (0.0, t(stumble)), "pause": 0.0},
            {"src": (t(stumble - back), total), "pause": PAUSE_RETRY},
        ]

    if kind == "retry3":
        # 3箇所でつまずく（練習の実態に近い）
        pts = [(int(n * 0.25), 2), (int(n * 0.50), 3), (int(n * 0.75), 1)]
        plan = []
        cur = 0.0
        for stumble, back in pts:
            plan.append({"src": (cur, t(stumble)), "pause": PAUSE_RETRY if plan else 0.0})
            cur = t(stumble - back)
        plan.append({"src": (cur, total), "pause": PAUSE_RETRY})
        return plan

    if kind == "retry_long":
        # 大きく戻る（8小節前の楽節頭から）
        stumble, back = int(n * 0.65), 8
        return [
            {"src": (0.0, t(stumble)), "pause": 0.0},
            {"src": (t(stumble - back), total), "pause": PAUSE_RETRY},
        ]

    if kind == "stop":
        # 戻らずにその場で止まる
        pause_at = t(int(n * 0.5))
        return [
            {"src": (0.0, pause_at), "pause": 0.0},
            {"src": (pause_at, total), "pause": PAUSE_STOP},
        ]

    if kind == "partial":
        # 中盤の1/3だけを練習する
        a, b = int(n * 0.33), int(n * 0.67)
        return [{"src": (t(a), t(b)), "pause": 0.0}]

    if kind == "partial_retry":
        # 部分練習の中で弾き直す（最も現実的なケース）
        a, b = int(n * 0.33), int(n * 0.67)
        stumble, back = int(n * 0.55), 2
        return [
            {"src": (t(a), t(stumble)), "pause": 0.0},
            {"src": (t(stumble - back), t(b)), "pause": PAUSE_RETRY},
        ]

    if kind == "skip":
        # 難所を飛ばす（弾けないので抜かす）
        a, b = int(n * 0.45), int(n * 0.55)
        return [
            {"src": (0.0, t(a)), "pause": 0.0},
            {"src": (t(b), total), "pause": 0.3},
        ]

    if kind == "repeat10":
        # 同じ2小節を10回繰り返す集中練習（テイク数が多い場合の跳躍ペナルティ積み上げを見る）
        a, b = int(n * 0.45), min(int(n * 0.45) + 2, n - 1)
        plan = [{"src": (0.0, t(a)), "pause": 0.0}]
        for k in range(10):
            plan.append({"src": (t(a), t(b)), "pause": PAUSE_RETRY if k else 0.0})
        plan.append({"src": (t(b), total), "pause": PAUSE_RETRY})
        return plan

    raise ValueError(kind)


def render(
    plan: list[dict],
    notes: list[pretty_midi.Note],
    ccs: list[pretty_midi.ControlChange],
    jitter: float,
    rng,
) -> tuple[pretty_midi.PrettyMIDI, list[dict]]:
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    truth: list[dict] = []
    seen: dict[int, int] = {}

    out_t = 0.0
    for seg in plan:
        s, e = seg["src"]
        out_t += seg["pause"]
        offset = out_t - s
        for i, n in enumerate(notes):
            if not (s <= n.start < e):
                continue
            d = float(rng.normal(0.0, jitter)) if jitter > 0 else 0.0
            start = max(0.0, n.start + offset + d)
            end = max(start + 0.02, n.end + offset + d)
            take = seen.get(i, 0)
            seen[i] = take + 1
            inst.notes.append(
                pretty_midi.Note(velocity=n.velocity, pitch=n.pitch, start=start, end=end)
            )
            truth.append({"srcIndex": i, "takeIndex": take, "start": round(start, 4)})
        for cc in ccs:
            if s <= cc.time < e:
                inst.control_changes.append(
                    pretty_midi.ControlChange(
                        number=64, value=cc.value, time=max(0.0, cc.time + offset)
                    )
                )
        out_t += e - s

    # 出力 MIDI の音符順（start, pitch）と truth の対応を取り直す
    order = sorted(range(len(inst.notes)), key=lambda k: (inst.notes[k].start, inst.notes[k].pitch))
    inst.notes = [inst.notes[k] for k in order]
    truth = [truth[k] for k in order]
    for out_index, rec in enumerate(truth):
        rec["outIndex"] = out_index
    inst.control_changes.sort(key=lambda c: c.time)
    pm.instruments.append(inst)
    return pm, truth


PLANS = [
    "none",
    "retry1",
    "retry3",
    "retry_long",
    "stop",
    "partial",
    "partial_retry",
    "skip",
    "repeat10",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--out", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--truth-out", type=Path, default=Path("out/replay_truth"))
    ap.add_argument("--jitter", type=float, default=0.015, help="発音時刻の揺らぎ（秒）")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    args.truth_out.mkdir(parents=True, exist_ok=True)

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    summary = []
    for piece in pieces:
        name = piece["name"]
        notes, ccs = load_gt(args.dataset / f"{name}.ref.mid")
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        mtimes = measure_times(reference)
        total = max(n.end for n in notes) + 0.5

        for kind in PLANS:
            rng = np.random.default_rng(RNG_SEED)
            plan = make_plan(kind, mtimes, total, rng)
            pm, truth = render(plan, notes, ccs, args.jitter, rng)
            label = f"r_{kind}"
            pm.write(str(args.out / f"{name}.{label}.mid"))
            (args.truth_out / f"{name}.{label}.truth.json").write_text(
                json.dumps(
                    {
                        "name": name,
                        "condition": label,
                        "plan": [
                            {"src": [round(a, 3), round(b, 3)], "pause": p["pause"]}
                            for p in plan
                            for a, b in [p["src"]]
                        ],
                        "notes": truth,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            retakes = sum(1 for r in truth if r["takeIndex"] > 0)
            summary.append(
                {
                    "name": name,
                    "condition": label,
                    "segments": len(plan),
                    "gtNotes": len(notes),
                    "outNotes": len(truth),
                    "retakeNotes": retakes,
                }
            )
            print(
                f"{name}/{label}: segments={len(plan)} out={len(truth)} "
                f"(gt={len(notes)}) retake={retakes}"
            )

    (args.truth_out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
