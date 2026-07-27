"""clean 音源から「スマホ・PCのマイクで録った」状況を模した音源を作る。

Ledger Lines は電子ピアノを持たない人が主対象なので、
評価はマイク録音の条件で成立しなければ意味がない。
劣化要因を段階的に足し、どの要因がどの指標を壊すかを切り分ける。

条件:
    clean      … 元の録音（Disklavier のホール録音）
    room       … 残響 + 空調ノイズ
    phone      … room + マイクの周波数特性 + Opus 圧縮
    phone_agc  … phone + 自動ゲイン制御（AGC）
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

SR = 16000
RNG = np.random.default_rng(20260725)


def make_room_ir(sr: int = SR, rt60: float = 0.45, pre_delay: float = 0.008) -> np.ndarray:
    """指数減衰ノイズによる簡易 IR。小さめの部屋を想定する。"""
    length = int(rt60 * 1.6 * sr)
    t = np.arange(length) / sr
    decay = np.exp(-6.9078 * t / rt60)  # -60 dB @ rt60
    ir = RNG.standard_normal(length) * decay
    # 初期反射が密になりすぎないよう低域寄りに整形する
    b, a = signal.butter(2, 6000 / (sr / 2), btype="low")
    ir = signal.lfilter(b, a, ir)
    ir[: int(pre_delay * sr)] = 0.0
    ir /= np.abs(ir).max() + 1e-12
    direct = np.zeros(length)
    direct[0] = 1.0
    return direct + 0.55 * ir  # 直接音 : 残響 のバランス


def pink_noise(n: int) -> np.ndarray:
    white = RNG.standard_normal(n)
    b = np.array([0.049922035, -0.095993537, 0.050612699, -0.004408786])
    a = np.array([1.0, -2.494956002, 2.017265875, -0.522189400])
    return signal.lfilter(b, a, white)


def add_noise(x: np.ndarray, snr_db: float) -> np.ndarray:
    noise = pink_noise(len(x))
    sig_p = float((x**2).mean())
    noi_p = float((noise**2).mean()) + 1e-12
    scale = np.sqrt(sig_p / (noi_p * 10 ** (snr_db / 10)))
    return x + noise * scale


def mic_response(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """小型マイクの特性: 低域のロールオフと高域の緩い減衰。"""
    b_hp, a_hp = signal.butter(2, 90 / (sr / 2), btype="high")
    y = signal.lfilter(b_hp, a_hp, x)
    b_lp, a_lp = signal.butter(1, 6800 / (sr / 2), btype="low")
    return signal.lfilter(b_lp, a_lp, y)


def apply_agc(
    x: np.ndarray,
    sr: int = SR,
    target_rms: float = 0.1,
    time_const: float = 0.35,
    max_gain_db: float = 14.0,
) -> np.ndarray:
    """移動 RMS を目標値に寄せる簡易 AGC。強弱の差を潰す働きをする。"""
    win = max(1, int(time_const * sr))
    kernel = np.ones(win) / win
    env = np.sqrt(np.convolve(x**2, kernel, mode="same") + 1e-12)
    gain = target_rms / (env + 1e-9)
    limit = 10 ** (max_gain_db / 20)
    gain = np.clip(gain, 1 / limit, limit)
    # ゲイン変化を滑らかにする（ポンピングを避ける）
    gain = np.convolve(gain, np.ones(win // 2 or 1) / (win // 2 or 1), mode="same")
    return x * gain


def opus_roundtrip(x: np.ndarray, sr: int = SR, bitrate: str = "48k") -> np.ndarray:
    """ffmpeg で Opus に通して戻す。ブラウザ録音の既定コーデックを模す。"""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.wav"
        enc = Path(td) / "enc.opus"
        dec = Path(td) / "out.wav"
        sf.write(src, x, sr, subtype="PCM_16")
        base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        subprocess.run([*base, "-i", str(src), "-c:a", "libopus", "-b:a", bitrate, str(enc)], check=True)
        subprocess.run([*base, "-i", str(enc), "-ar", str(sr), "-ac", "1", str(dec)], check=True)
        y, _ = sf.read(dec, dtype="float32")
    if len(y) < len(x):
        y = np.pad(y, (0, len(x) - len(y)))
    return y[: len(x)]


def normalize(x: np.ndarray, peak: float = 0.9) -> np.ndarray:
    m = float(np.abs(x).max())
    return x if m == 0 else x / m * peak


def build_conditions(clean: np.ndarray, ir: np.ndarray) -> dict[str, np.ndarray]:
    room = signal.fftconvolve(clean, ir)[: len(clean)]
    room = normalize(add_noise(room, snr_db=34.0))

    phone = normalize(opus_roundtrip(normalize(mic_response(room))))
    phone_agc = normalize(apply_agc(phone))

    return {"room": room, "phone": phone, "phone_agc": phone_agc}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    args = ap.parse_args()

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    ir = make_room_ir()
    sf.write(args.dataset / "_room_ir.wav", normalize(ir), SR, subtype="PCM_16")

    for piece in pieces:
        clean, sr = sf.read(args.dataset / f"{piece['name']}.clean.wav", dtype="float32")
        assert sr == SR, f"unexpected sample rate {sr}"
        for cond, y in build_conditions(clean, ir).items():
            sf.write(args.dataset / f"{piece['name']}.{cond}.wav", y, SR, subtype="PCM_16")
        print(f"{piece['name']}: generated room / phone / phone_agc")

    print(f"\ndegraded {len(pieces)} piece(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
