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

# poc/scripts/estimate_quality.py:19-21 の FRAME=2048 / HOP=512 / EPS=1e-10 と同一。
# SR=16000 では 128 ms 窓・32 ms ホップ（重なりあり）に相当する。秒で持つのは
# 16 kHz 以外の入力でも窓の「時間長」を保つためで、SR ではちょうど 2048 / 512
# サンプルになる（poc 側も degrade.py の SR=16000 前提で測られている）。
DYNAMIC_RANGE_FRAME_SEC = 2048 / SR
DYNAMIC_RANGE_HOP_SEC = 512 / SR
DYNAMIC_RANGE_EPS = 1e-10


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


def dynamic_range_db(audio: np.ndarray, sr: int) -> float:
    """フレームRMSの95/5パーセンタイル差(dB)。

    `poc/scripts/estimate_quality.py:24-35` の `frame_rms` / `features` と同一の推定量。
    metrics.md 7.4 の AGC 判定（10 dB 未満）と劣化録音判定（14 dB 未満）の閾値は、
    m4-report.md 5.1 で**この推定量によって**実測された値である（clean/room/phone は
    16 dB 以上、phone_agc は 5.0〜7.1 dB に分離した）。したがって以下の3点は
    閾値と一体であり、閾値を再測定せずに変更してはならない:

      1. 窓 2048 サンプル・ホップ 512 サンプル（16 kHz で 128 ms / 32 ms、**重なりあり**）。
         窓を短くすると1音ごとのアタック/減衰を分解してしまい p95−p5 が系統的に
         大きく出る。スマホの AGC は時定数が数十〜数百 ms なので1音の減衰そのものは
         平らにできず、短い窓では「AGC なのにレンジが広い」と誤って見える。
      2. フレーム RMS は `sqrt(mean(x^2) + EPS)`。EPS がフロアなので無音フレームも
         捨てずに全フレームを使う（無音の多い録音で p5 の意味が変わらないように）。
      3. パーセンタイルは **dB 領域**で取る（線形 RMS で取ってから dB 変換しない）。
         metrics.md 7.4 の式 `percentile95(frameRmsDb) - percentile5(frameRmsDb)` も
         dB 領域である。

    M4 のハーネスとの意図的な差: `estimate_quality.py` はトリム前の音声に適用するが、
    `preprocess()` はこれを `trimmed`（無音トリム後）に適用する。先頭・末尾の無音は
    p5 を押し下げてレンジを過大に見せるため、製品側ではトリム後が正しいと判断した。

    退化入力: 完全な無音は全フレームが同じ EPS フロアになるため 0.0。1フレームに
    満たない入力は `estimate_quality.frame_rms` と同じく n=1 となり、p95 と p5 が
    同一フレームを指すので 0.0 になる。
    """
    frame = max(1, int(round(DYNAMIC_RANGE_FRAME_SEC * sr)))
    hop = max(1, int(round(DYNAMIC_RANGE_HOP_SEC * sr)))
    samples = np.asarray(audio, dtype=np.float64)
    if samples.size == 0:
        return 0.0
    # フレーム数は estimate_quality.frame_rms と同一。i = n-1 のとき
    # (n-1)*hop + frame <= len が成り立つので、末尾の端数は最後の完全フレームに
    # 含まれずに捨てられる（1フレームに満たない入力のときだけ n=1 で短い窓になる）。
    n = 1 + max(0, (samples.size - frame) // hop)
    rms = np.array(
        [
            np.sqrt(np.mean(np.square(samples[i * hop : i * hop + frame])) + DYNAMIC_RANGE_EPS)
            for i in range(n)
        ]
    )
    db = 20.0 * np.log10(rms + DYNAMIC_RANGE_EPS)
    return round(float(np.percentile(db, 95) - np.percentile(db, 5)), 2)


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
        "dynamicRangeDb": dynamic_range_db(trimmed, sr),
        "durationSec": round(duration_sec, 2),
        "trimOffsetSec": round(trim_offset_sec, 3),
    }
