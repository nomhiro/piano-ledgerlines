"""実録音を使った弾き直しの検証（M5 持ち越し課題3）。

perturb_replay.py は ground truth MIDI の時間軸を組み替えるだけで、
採譜のノイズを含まない「アライメントの構造」だけを見るものだった。

ここでは同じセグメント計画を、実際に録音された音声（piece0X.clean.wav）に適用する。
該当区間を波形レベルで切り出して結合し、間（pause）は無音を挿入する。
これを実際に採譜モデルに通すことで、
「採譜ノイズ」と「弾き直しへの追従」を同時に検証できる。

出力する条件名は r_* と衝突しないよう a_* にする。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from perturb_replay import RNG_SEED, load_gt, make_plan, measure_times, render

SR = 16000
# 検証に使う条件。全8条件を実音声で回すと採譜コストが大きいため、
# 対照・中程度の弾き直し・最悪ケース・反復練習の4つに絞る。
CONDITIONS = ["none", "retry3", "partial_retry", "repeat10"]


def slice_audio(audio: np.ndarray, plan: list[dict]) -> np.ndarray:
    """プランのセグメントに従って実音声を切り出し・結合する。"""
    chunks: list[np.ndarray] = []
    for seg in plan:
        s, e = seg["src"]
        pause = seg["pause"]
        if pause > 0:
            chunks.append(np.zeros(int(round(pause * SR)), dtype=np.float32))
        i0, i1 = int(round(s * SR)), int(round(e * SR))
        i0 = max(0, min(i0, len(audio)))
        i1 = max(i0, min(i1, len(audio)))
        chunks.append(audio[i0:i1])
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--truth-out", type=Path, default=Path("out/replay_truth_audio"))
    ap.add_argument("--source-condition", default="clean", help="切り出し元の実録音条件")
    ap.add_argument("--conditions", nargs="*", default=CONDITIONS)
    ap.add_argument("--pieces", nargs="*", default=None)
    args = ap.parse_args()

    args.truth_out.mkdir(parents=True, exist_ok=True)

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    summary = []
    for piece in pieces:
        name = piece["name"]
        if args.pieces and name not in args.pieces:
            continue
        wav_path = args.dataset / f"{name}.{args.source_condition}.wav"
        if not wav_path.exists():
            continue
        audio, sr = sf.read(wav_path, dtype="float32")
        assert sr == SR, f"expected {SR} Hz, got {sr}"

        notes, ccs = load_gt(args.dataset / f"{name}.ref.mid")
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        mtimes = measure_times(reference)
        total = max(n.end for n in notes) + 0.5

        for kind in args.conditions:
            rng = np.random.default_rng(RNG_SEED)
            plan = make_plan(kind, mtimes, total, rng)
            # truth（srcIndex/takeIndex/start の対応）は MIDI 版と同じロジックで作る。
            # render() が返す MIDI 自体は使わず、対応表だけ利用する。
            _, truth = render(plan, notes, ccs, jitter=0.0, rng=rng)
            audio_out = slice_audio(audio, plan)

            label = f"a_{kind}"
            out_wav = args.dataset / f"{name}.{label}.wav"
            sf.write(out_wav, audio_out, SR, subtype="PCM_16")

            (args.truth_out / f"{name}.{label}.truth.json").write_text(
                json.dumps(
                    {
                        "name": name,
                        "condition": label,
                        "sourceCondition": args.source_condition,
                        "gtNoteCount": len(notes),
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
            played = len({r["srcIndex"] for r in truth})
            dur = len(audio_out) / SR
            summary.append(
                {
                    "name": name,
                    "condition": label,
                    "segments": len(plan),
                    "gtNotes": len(notes),
                    "played": played,
                    "retakeNotes": retakes,
                    "durationSec": round(dur, 2),
                }
            )
            print(
                f"{name}/{label}: segments={len(plan)} played={played}/{len(notes)} "
                f"retake={retakes} duration={dur:.1f}s"
            )

    (args.truth_out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
