"""ground truth の演奏 MIDI から「楽譜相当」の参照譜を作る。

MAESTRO には楽譜がないため、アライメント検証には参照譜を用意する必要がある。
実アプリと同じ構造（楽譜 = 拍の格子上の音符列 / 演奏 = 秒単位）を作るため、
音声からビートを推定し、その格子に演奏 MIDI をスナップして参照譜とする。

参照譜の各音符は ground truth のどの音符から来たかを保持する。
これにより「採譜結果 → ground truth → 参照譜」の連鎖で
アライメントの正解対応が作れる（evaluate_alignment.py が使う）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf

SR = 16000
SUBDIVISION = 8  # 1拍を32分音符相当まで分割する（粗いと繰り返し音が同一格子に潰れる）


def estimate_beat_grid(audio: np.ndarray, sr: int = SR) -> np.ndarray:
    """音声からビート時刻を推定し、拍内を細分した格子時刻を返す。"""
    tempo, beats = librosa.beat.beat_track(y=audio, sr=sr, units="time", trim=False)
    beats = np.asarray(beats, dtype=float)
    if beats.size < 2:
        raise RuntimeError("beat tracking failed")

    # 端を外挿して、先頭・末尾の音符も格子に載るようにする
    step_head = beats[1] - beats[0]
    step_tail = beats[-1] - beats[-2]
    beats = np.concatenate(
        [[beats[0] - step_head], beats, [beats[-1] + step_tail, beats[-1] + 2 * step_tail]]
    )

    grid_times = []
    grid_beats = []
    for i in range(len(beats) - 1):
        for s in range(SUBDIVISION):
            frac = s / SUBDIVISION
            grid_times.append(beats[i] + (beats[i + 1] - beats[i]) * frac)
            grid_beats.append(i + frac)
    return np.array(grid_times), np.array(grid_beats), float(np.atleast_1d(tempo)[0])


def build_reference(pm: pretty_midi.PrettyMIDI, grid_t: np.ndarray, grid_b: np.ndarray) -> list[dict]:
    """演奏 MIDI を拍格子にスナップして参照譜を作る。"""
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    ref = []
    for gt_index, note in enumerate(notes):
        s = int(np.argmin(np.abs(grid_t - note.start)))
        e = max(int(np.argmin(np.abs(grid_t - note.end))), s + 1)
        start_beat = float(grid_b[s])
        if e < len(grid_b):
            end_beat = float(grid_b[e])
        else:
            # 格子の末尾を超える音符は刻み幅で外挿する
            end_beat = float(grid_b[-1]) + (e - len(grid_b) + 1) / SUBDIVISION
        ref.append(
            {
                "index": len(ref),
                "gtIndex": gt_index,
                "pitch": int(note.pitch),
                "startBeat": round(start_beat, 4),
                "durationBeats": round(max(end_beat - start_beat, 1 / SUBDIVISION), 4),
                # 楽譜は絶対的な音量を持たないので、強弱は3段階に丸める
                "dynamicLevel": 0 if note.velocity < 48 else (1 if note.velocity < 80 else 2),
                "gtStart": round(note.start, 4),
            }
        )
    return ref


def assign_measures(ref: list[dict], beats_per_measure: int = 4) -> None:
    for note in ref:
        note["measure"] = int(note["startBeat"] // beats_per_measure) + 1
        note["beatInMeasure"] = round(note["startBeat"] % beats_per_measure + 1, 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--out", type=Path, default=Path("out/reference"))
    ap.add_argument("--beats-per-measure", type=int, default=4)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))

    summary = []
    for piece in pieces:
        audio, sr = sf.read(args.dataset / f"{piece['name']}.clean.wav", dtype="float32")
        grid_t, grid_b, tempo = estimate_beat_grid(audio, sr)
        pm = pretty_midi.PrettyMIDI(str(args.dataset / f"{piece['name']}.ref.mid"))
        ref = build_reference(pm, grid_t, grid_b)
        assign_measures(ref, args.beats_per_measure)

        # 楽譜としての「拍 -> 秒」の正解対応も残す（BeatMap の評価に使う）
        beat_map = [
            {"time": round(float(t), 4), "beat": round(float(b), 4)}
            for t, b in zip(grid_t[::SUBDIVISION], grid_b[::SUBDIVISION])
        ]

        doc = {
            "name": piece["name"],
            "estimatedTempo": round(tempo, 2),
            "beatsPerMeasure": args.beats_per_measure,
            "measureCount": max(n["measure"] for n in ref),
            "notes": ref,
            "beatMap": beat_map,
        }
        (args.out / f"{piece['name']}.reference.json").write_text(
            json.dumps(doc, ensure_ascii=False), encoding="utf-8"
        )
        summary.append(
            {
                "name": piece["name"],
                "tempo": doc["estimatedTempo"],
                "notes": len(ref),
                "measures": doc["measureCount"],
            }
        )
        print(
            f"{piece['name']}: tempo={doc['estimatedTempo']:.1f} "
            f"notes={len(ref)} measures={doc['measureCount']}"
        )

    (args.out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
