"""S0: 前処理（デコード・リサンプル・無音トリム・品質チェック）。

analysis-pipeline.md 2章準拠。ffmpeg で16kHzモノラルへ変換し、
無音トリムと品質チェック（音量・長さ）を行う。
正規化は行わない（ダイナミクス評価のため相対音量を保持する）。
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

SR = 16000
SILENCE_DBFS = -50.0
TRIM_MARGIN_SEC = 0.3
MIN_DURATION_SEC = 3.0
MAX_DURATION_SEC = 15 * 60
TOO_QUIET_DBFS = -45.0


class PreprocessError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def decode_to_wav(src: Path, dst: Path) -> None:
    """ffmpeg で 16kHz モノラル PCM WAV に変換する。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16",
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise PreprocessError("INTERNAL", f"ffmpeg failed: {result.stderr[-500:]}")


def _dbfs(rms: float) -> float:
    return 20.0 * float(np.log10(max(rms, 1e-9)))


def trim_silence(audio: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """先頭・末尾の無音を除去し、余白を残す。トリムオフセット(秒)も返す。"""
    threshold = 10 ** (SILENCE_DBFS / 20.0)
    above = np.where(np.abs(audio) > threshold)[0]
    if above.size == 0:
        return audio, 0.0
    margin = int(TRIM_MARGIN_SEC * sr)
    start = max(0, int(above[0]) - margin)
    end = min(len(audio), int(above[-1]) + margin)
    return audio[start:end], float(start) / sr


def preprocess(src: Path, work_dir: Path) -> dict[str, Any]:
    """音声を前処理し、preprocessed.wav と meta を返す。失敗時は PreprocessError。"""
    raw_wav = work_dir / "decoded.wav"
    decode_to_wav(src, raw_wav)

    audio, sr = sf.read(raw_wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    duration_sec = len(audio) / sr
    if duration_sec < MIN_DURATION_SEC or duration_sec > MAX_DURATION_SEC:
        raise PreprocessError(
            "INVALID_LENGTH", f"duration {duration_sec:.1f}s out of range"
        )

    trimmed, trim_offset_sec = trim_silence(audio, sr)
    if len(trimmed) == 0:
        raise PreprocessError("AUDIO_TOO_QUIET", "no signal above silence threshold")

    rms = float(np.sqrt(np.mean(np.square(trimmed))))
    rms_dbfs = _dbfs(rms)
    if rms_dbfs < TOO_QUIET_DBFS:
        raise PreprocessError("AUDIO_TOO_QUIET", f"rms {rms_dbfs:.1f} dBFS below threshold")

    peak_dbfs = _dbfs(float(np.max(np.abs(trimmed))) if len(trimmed) else 0.0)
    clipping_rate = float(np.mean(np.abs(trimmed) > 0.99))

    out_path = work_dir / "preprocessed.wav"
    sf.write(out_path, trimmed, sr, subtype="PCM_16")

    return {
        "path": out_path,
        "rmsDbfs": round(rms_dbfs, 2),
        "peakDbfs": round(peak_dbfs, 2),
        "clippingRate": round(clipping_rate, 4),
        "durationSec": round(duration_sec, 2),
        "trimOffsetSec": round(trim_offset_sec, 3),
    }
