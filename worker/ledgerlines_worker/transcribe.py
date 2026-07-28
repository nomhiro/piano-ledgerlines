"""S2: 採譜（Audio → MIDI）。

poc/scripts/transcribe.py と同じ piano_transcription_inference を CPU で使う。
ONNX化（poc/scripts/transcribe_onnx.py, M4.5で2倍速確認済み）は
このワーカーではまだ適用していない（速度は後続の最適化課題）。
"""

from __future__ import annotations

import os
from pathlib import Path

import soundfile as sf

SR = 16000
DEFAULT_CHECKPOINT = Path.home() / "piano_transcription_inference_data" / (
    "note_F1=0.9677_pedal_F1=0.9186.pth"
)


def transcribe(preprocessed_wav: Path, out_midi: Path, checkpoint_path: Path | None = None) -> None:
    """前処理済みWAVをMIDIに採譜する。"""
    from piano_transcription_inference import PianoTranscription

    audio, sr = sf.read(preprocessed_wav, dtype="float32")
    if sr != SR:
        raise ValueError(f"expected {SR}Hz input, got {sr}")

    ckpt = checkpoint_path or DEFAULT_CHECKPOINT
    kwargs = {"device": "cpu"}
    if ckpt and Path(ckpt).exists():
        kwargs["checkpoint_path"] = str(ckpt)

    model = PianoTranscription(**kwargs)
    out_midi.parent.mkdir(parents=True, exist_ok=True)
    model.transcribe(audio, str(out_midi))
