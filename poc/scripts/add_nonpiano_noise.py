"""ピアノ以外の音（メトロノーム・話し声）を混ぜた場合の採譜への影響を見る（M5 持ち越し課題5）。

本アプリの利用者は自宅で練習しながら録音するため、
メトロノームのクリック音や、家族・自分の話し声が録音に混ざることが日常的に起きる。
これらが採譜（ひいては音程・リズム・ペダル指標）をどれだけ壊すかを測る。

Azure Speech 等の実音声合成は使わず、音声認識のドメインではなく
「ピアノと無関係な音がどれだけ紛れ込むと採譜が壊れるか」を切り分けたいので、
帯域・時間特性だけを模した合成音（クリック音／話し声様のバースト雑音）を使う。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

SR = 16000
RNG = np.random.default_rng(20260910)


def metronome_track(n_samples: int, bpm: float = 92.0, click_gain: float = 0.35) -> np.ndarray:
    """一定テンポのクリック音（減衰する短いトーンバースト）。"""
    track = np.zeros(n_samples, dtype=np.float32)
    period = 60.0 / bpm
    click_len = int(0.02 * SR)
    t = np.arange(click_len) / SR
    click = np.sin(2 * np.pi * 2200 * t) * np.exp(-t / 0.006)
    click = click.astype(np.float32)
    pos = 0.0
    while int(pos * SR) < n_samples - click_len:
        i = int(pos * SR)
        track[i : i + click_len] += click
        pos += period
    peak = np.abs(track).max()
    if peak > 0:
        track = track / peak * click_gain
    return track


def voice_like_track(n_samples: int, level: float = 0.12) -> np.ndarray:
    """話し声を模したバースト雑音。300-3400Hz に帯域制限し、断続的に鳴らす。"""
    noise = RNG.standard_normal(n_samples).astype(np.float32)
    b, a = signal.butter(4, [300 / (SR / 2), 3400 / (SR / 2)], btype="band")
    noise = signal.lfilter(b, a, noise).astype(np.float32)

    # 発話のような断続パターン: 0.3〜1.2秒の有音 + 0.5〜2.0秒の無音を繰り返す
    envelope = np.zeros(n_samples, dtype=np.float32)
    pos = 0
    while pos < n_samples:
        gap = int(RNG.uniform(0.5, 2.0) * SR)
        pos += gap
        burst = int(RNG.uniform(0.3, 1.2) * SR)
        end = min(pos + burst, n_samples)
        if pos < n_samples:
            ramp = min(400, (end - pos) // 2) or 1
            seg = np.ones(end - pos, dtype=np.float32)
            seg[:ramp] = np.linspace(0, 1, ramp)
            seg[-ramp:] = np.linspace(1, 0, ramp)
            envelope[pos:end] = seg
        pos = end

    voice = noise * envelope
    peak = np.abs(voice).max()
    if peak > 0:
        voice = voice / peak * level
    return voice


def normalize(x: np.ndarray, peak: float = 0.9) -> np.ndarray:
    m = float(np.abs(x).max())
    return x if m == 0 else x / m * peak


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--source-condition", default="clean")
    ap.add_argument("--pieces", nargs="*", default=None)
    args = ap.parse_args()

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    for piece in pieces:
        name = piece["name"]
        if args.pieces and name not in args.pieces:
            continue
        wav = args.dataset / f"{name}.{args.source_condition}.wav"
        clean, sr = sf.read(wav, dtype="float32")
        assert sr == SR, f"unexpected sample rate {sr}"
        n = len(clean)

        metro = metronome_track(n)
        voice = voice_like_track(n)

        conditions = {
            "metronome": normalize(clean + metro),
            "voice": normalize(clean + voice),
            "metronome_voice": normalize(clean + metro + voice),
        }
        for cond, y in conditions.items():
            sf.write(args.dataset / f"{name}.{cond}.wav", y, SR, subtype="PCM_16")
        print(f"{name}: generated metronome / voice / metronome_voice")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
