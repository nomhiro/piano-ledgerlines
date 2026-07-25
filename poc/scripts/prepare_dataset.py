"""MAESTRO の抽出済み音声と MIDI zip から、PoC 用データセットを組み立てる。

各曲について
  - 冒頭の無音を避けた位置から一定秒数を切り出す
  - 16 kHz モノラルの clean 音源を書き出す
  - 同じ時間窓の ground truth MIDI を書き出す（時刻は窓の先頭を 0 とする）
を行う。
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

TARGET_SR = 16000


def load_manifest_entries(raw_dirs: list[Path]) -> list[dict]:
    entries = []
    for d in raw_dirs:
        manifest = d / "manifest.json"
        if not manifest.exists():
            continue
        for item in json.loads(manifest.read_text(encoding="utf-8")):
            item["dir"] = str(d)
            entries.append(item)
    return entries


def midi_name_from_id(take_id: str) -> str:
    """id は 'xxx.wav:yyy.midi' の形式。MIDI 側だけを取り出す。"""
    return take_id.split(":")[-1]


def find_onset_start(audio: np.ndarray, sr: int, threshold_db: float = -45.0) -> float:
    """最初に音が立ち上がる位置（秒）を返す。無音の頭を捨てるために使う。"""
    frame = int(0.02 * sr)
    if frame < 1:
        return 0.0
    usable = len(audio) - len(audio) % frame
    frames = audio[:usable].reshape(-1, frame)
    rms = np.sqrt((frames**2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    above = np.flatnonzero(db > threshold_db)
    if above.size == 0:
        return 0.0
    return max(0.0, above[0] * frame / sr - 0.2)


def slice_midi(pm: pretty_midi.PrettyMIDI, start: float, end: float) -> pretty_midi.PrettyMIDI:
    """[start, end) の音符とペダルを抜き出し、時刻を start 起点に平行移動する。"""
    out = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    src = pm.instruments[0]
    inst = pretty_midi.Instrument(program=src.program, is_drum=False, name="piano")

    for note in src.notes:
        if note.end <= start or note.start >= end:
            continue
        inst.notes.append(
            pretty_midi.Note(
                velocity=note.velocity,
                pitch=note.pitch,
                start=max(0.0, note.start - start),
                end=min(end, note.end) - start,
            )
        )

    for cc in src.control_changes:
        if cc.time < start or cc.time >= end:
            continue
        inst.control_changes.append(
            pretty_midi.ControlChange(number=cc.number, value=cc.value, time=cc.time - start)
        )

    out.instruments.append(inst)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--midi-zip", type=Path, default=Path("data/maestro-midi.zip"))
    ap.add_argument("--out", type=Path, default=Path("data/dataset"))
    ap.add_argument("--seconds", type=float, default=90.0)
    args = ap.parse_args()

    raw_dirs = sorted(p for p in args.data.iterdir() if p.is_dir() and p.name.startswith("raw"))
    entries = load_manifest_entries(raw_dirs)
    if not entries:
        print("no raw entries found")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    zf = zipfile.ZipFile(args.midi_zip)
    names = {Path(n).as_posix(): n for n in zf.namelist()}

    dataset = []
    for idx, entry in enumerate(entries):
        wav_path = Path(entry["dir"]) / entry["wav"]
        midi_rel = midi_name_from_id(entry["id"])
        zip_key = next((v for k, v in names.items() if k.endswith(midi_rel)), None)
        if zip_key is None:
            print(f"[skip] MIDI not found in zip: {midi_rel}")
            continue

        audio, sr = sf.read(wav_path, dtype="float32", always_2d=True)
        mono = audio.mean(axis=1)

        start = find_onset_start(mono, sr)
        end = start + args.seconds
        if end * sr > len(mono):
            end = len(mono) / sr
        segment = mono[int(start * sr) : int(end * sr)]

        # 16 kHz へダウンサンプル（採譜モデルの入力仕様に合わせる）
        import librosa

        segment16 = librosa.resample(segment, orig_sr=sr, target_sr=TARGET_SR)
        peak = float(np.abs(segment16).max())
        if peak > 0:
            segment16 = segment16 / peak * 0.9

        name = f"piece{idx:02d}"
        sf.write(args.out / f"{name}.clean.wav", segment16, TARGET_SR, subtype="PCM_16")

        with zf.open(zip_key) as fh:
            pm = pretty_midi.PrettyMIDI(fh)
        sliced = slice_midi(pm, start, end)
        sliced.write(str(args.out / f"{name}.ref.mid"))

        pedal_cc = [c for c in sliced.instruments[0].control_changes if c.number == 64]
        info = {
            "name": name,
            "source_id": entry["id"],
            "source_wav": str(wav_path),
            "orig_sr": sr,
            "window": [round(start, 3), round(end, 3)],
            "duration": round(end - start, 3),
            "note_count": len(sliced.instruments[0].notes),
            "pedal_cc_count": len(pedal_cc),
        }
        dataset.append(info)
        print(
            f"{name}: {info['duration']:.1f}s notes={info['note_count']} "
            f"pedalCC={info['pedal_cc_count']} src_sr={sr}"
        )

    (args.out / "dataset.json").write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nprepared {len(dataset)} piece(s) in {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
