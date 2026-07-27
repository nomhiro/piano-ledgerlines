"""採譜モデルを ONNX に変換し、int8 動的量子化まで行う。

M4 で採譜が解析コストの64%を占めることがわかった（RTF 1.15）。
ONNX Runtime + int8 量子化で速くなるか、精度をどれだけ失うかを測る。

このモデルは常に固定長 10 秒（160,000 サンプル）・バッチ1 で呼ばれるので、
動的軸を使わず固定形状でエクスポートできる。量子化にも有利。
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import torch
from piano_transcription_inference import PianoTranscription
from piano_transcription_inference.pytorch_utils import move_data_to_device

SR = 16000
SEGMENT_SAMPLES = SR * 10
OUTPUT_NAMES = [
    "reg_onset_output",
    "reg_offset_output",
    "frame_output",
    "velocity_output",
    "reg_pedal_onset_output",
    "reg_pedal_offset_output",
    "pedal_frame_output",
]


class Wrapper(torch.nn.Module):
    """dict を返す forward を、ONNX が扱えるタプル返しに直す。"""

    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor):
        out = self.model(x)
        return tuple(out[k] for k in OUTPUT_NAMES)


def load_model(checkpoint: Path | None) -> torch.nn.Module:
    tr = PianoTranscription(device="cpu", checkpoint_path=str(checkpoint) if checkpoint else None)
    model = tr.model
    model.eval()
    return model


def export(model: torch.nn.Module, out: Path, opset: int) -> None:
    wrapper = Wrapper(model).eval()
    dummy = torch.zeros((1, SEGMENT_SAMPLES), dtype=torch.float32)
    out.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (dummy,),
            str(out),
            input_names=["waveform"],
            output_names=OUTPUT_NAMES,
            opset_version=opset,
            do_constant_folding=True,
            dynamo=False,
        )
    print(f"exported: {out} ({out.stat().st_size / 1e6:.1f} MB)")


def quantize(src: Path, dst: Path, variant: str = "matmul") -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    # このモデルは CNN + biGRU。動的量子化は MatMul 系にしか効かないので、
    # 何をどこまで量子化するかで速度が大きく変わる
    opts: dict = {}
    if variant == "matmul":
        # 重みが定数の MatMul だけ。実行時の量子化コストを持ち込まない
        kwargs = {"op_types_to_quantize": ["MatMul"]}
    elif variant == "all":
        kwargs = {}
        opts["MatMulConstBOnly"] = False
    elif variant == "conv":
        kwargs = {"op_types_to_quantize": ["Conv", "MatMul"]}
    else:
        raise ValueError(variant)

    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
        extra_options=opts or None,
        **kwargs,
    )
    print(f"quantized[{variant}]: {dst} ({dst.stat().st_size / 1e6:.1f} MB)")


def make_session(path: Path, threads: int):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


def compare(model: torch.nn.Module, paths: dict[str, Path], threads: int, trials: int) -> None:
    rng = np.random.default_rng(20260727)
    # 実際の音声に近い分布を作る（無音だと量子化の誤差が出ない）
    x = (rng.standard_normal((1, SEGMENT_SAMPLES)).astype(np.float32) * 0.05).clip(-1, 1)

    with torch.no_grad():
        t0 = time.perf_counter()
        for _ in range(trials):
            ref_out = Wrapper(model)(torch.from_numpy(x))
        torch_ms = (time.perf_counter() - t0) / trials * 1000
    ref = {k: v.numpy() for k, v in zip(OUTPUT_NAMES, ref_out)}
    print(f"\n{'model':<12} {'ms/10s':>9} {'RTF':>7}  max|Δ| per output")
    print(f"{'pytorch':<12} {torch_ms:>9.1f} {torch_ms / 10000:>7.3f}")

    for label, path in paths.items():
        if not path.exists():
            continue
        sess = make_session(path, threads)
        sess.run(None, {"waveform": x})  # warmup
        t0 = time.perf_counter()
        for _ in range(trials):
            outs = sess.run(None, {"waveform": x})
        ms = (time.perf_counter() - t0) / trials * 1000
        diffs = {
            k: float(np.abs(o - ref[k]).max())
            for k, o in zip([o.name for o in sess.get_outputs()], outs)
        }
        worst = ", ".join(f"{k.replace('_output', '')}={v:.4f}" for k, v in diffs.items())
        print(f"{label:<12} {ms:>9.1f} {ms / 10000:>7.3f}  {worst}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path("out/onnx"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--variants", nargs="*", default=["matmul", "conv", "all"])
    ap.add_argument("--skip-export", action="store_true")
    ap.add_argument("--skip-quantize", action="store_true")
    args = ap.parse_args()

    fp32 = args.out / "note_pedal.onnx"
    model = load_model(args.checkpoint)
    if not args.skip_export:
        export(model, fp32, args.opset)

    paths = {"onnx fp32": fp32}
    for v in args.variants:
        dst = args.out / f"note_pedal.int8_{v}.onnx"
        if not args.skip_quantize:
            quantize(fp32, dst, v)
        paths[f"int8/{v}"] = dst

    compare(model, paths, args.threads, args.trials)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
