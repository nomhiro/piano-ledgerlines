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


class TranscribeError(Exception):
    """S2（採譜）に固有の失敗。

    `preprocess.PreprocessError`（S0の入力起因の失敗）とは別の層・別の原因の
    失敗なので使い分ける ── ここでの失敗は録音の良し悪しとは無関係な、
    モデルの提供不備（チェックポイント未配置など）を表す。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def transcribe(preprocessed_wav: Path, out_midi: Path, checkpoint_path: Path | None = None) -> None:
    """前処理済みWAVをMIDIに採譜する。"""
    from piano_transcription_inference import PianoTranscription

    audio, sr = sf.read(preprocessed_wav, dtype="float32")
    if sr != SR:
        raise ValueError(f"expected {SR}Hz input, got {sr}")

    ckpt = checkpoint_path or DEFAULT_CHECKPOINT
    if not Path(ckpt).exists():
        # ここでチェックポイント欠落を素通りさせると、ライブラリ既定の wget
        # 自動取得が走る。本番イメージには wget が無いため必ず失敗し、
        # 「[Errno 2] No such file or directory: <path>」という、運用者にも
        # 原因が伝わらない汎用エラーになる（このバグの発生源）。ここで検出し、
        # 専用コードで落とすことで worker_main.py 側が failure.code を
        # INTERNAL ではなく操作可能な値にできる。
        raise TranscribeError(
            "MODEL_CHECKPOINT_MISSING",
            f"transcription checkpoint not found at {ckpt}",
        )

    model = PianoTranscription(checkpoint_path=str(ckpt), device="cpu")
    out_midi.parent.mkdir(parents=True, exist_ok=True)
    model.transcribe(audio, str(out_midi))
