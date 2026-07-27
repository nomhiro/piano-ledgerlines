"""ONNX Runtime で採譜し、PyTorch 版との速度・出力一致を実測する。

export_onnx.py が作った ONNX を使い、前後処理は piano_transcription_inference の
ものをそのまま流用する。差し替えるのはモデルの forward だけ。

M4 の transcribe.py と同じ MIDI を書き出すので、
evaluate_transcription.py でそのまま精度比較できる。
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from piano_transcription_inference import PianoTranscription

OUTPUT_NAMES = [
    "reg_onset_output",
    "reg_offset_output",
    "frame_output",
    "velocity_output",
    "reg_pedal_onset_output",
    "reg_pedal_offset_output",
    "pedal_frame_output",
]


class OnnxModel(torch.nn.Module):
    """PianoTranscription が期待するインターフェースを ONNX セッションで満たす。"""

    def __init__(self, path: Path, threads: int):
        super().__init__()
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        self.names = [o.name for o in self.sess.get_outputs()]
        # forward() が device を引くための細工
        self.register_parameter("_anchor", torch.nn.Parameter(torch.zeros(1)))

    def forward(self, x: torch.Tensor) -> dict:
        arr = x.detach().cpu().numpy().astype(np.float32)
        outs = self.sess.run(None, {"waveform": arr})
        return {k: torch.from_numpy(v) for k, v in zip(self.names, outs)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--out", type=Path, default=Path("out/transcribed_onnx"))
    ap.add_argument("--model", type=Path, default=Path("out/onnx/note_pedal.onnx"))
    ap.add_argument("--checkpoint", type=Path, default=None)
    ap.add_argument("--conditions", nargs="*", default=["clean", "room", "phone", "phone_agc"])
    ap.add_argument("--pieces", nargs="*", default=None)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--suffix", default="", help="出力 MIDI 名に付ける識別子")
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    args.out.mkdir(parents=True, exist_ok=True)

    tr = PianoTranscription(
        device="cpu", checkpoint_path=str(args.checkpoint) if args.checkpoint else None
    )
    tr.model = OnnxModel(args.model, args.threads)

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    rows = []
    for piece in pieces:
        name = piece["name"]
        if args.pieces and name not in args.pieces:
            continue
        for cond in args.conditions:
            wav = args.dataset / f"{name}.{cond}.wav"
            if not wav.exists():
                continue
            audio, sr = sf.read(wav, dtype="float32")
            dur = len(audio) / sr
            t0 = time.perf_counter()
            tr.transcribe(audio, str(args.out / f"{name}.{cond}{args.suffix}.mid"))
            elapsed = time.perf_counter() - t0
            rows.append(
                {
                    "name": name,
                    "condition": cond,
                    "duration": round(dur, 2),
                    "elapsed": round(elapsed, 2),
                    "rtf": round(elapsed / dur, 3),
                    "threads": args.threads,
                }
            )
            print(f"{name}/{cond}: {elapsed:.1f}s for {dur:.1f}s (RTF {elapsed / dur:.3f})",
                  flush=True)

    if rows:
        (args.out / f"rtf{args.suffix}.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\nmean RTF = {np.mean([r['rtf'] for r in rows]):.3f} "
              f"({args.threads} threads, onnx)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
