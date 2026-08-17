"""metrics.md の指標を、参照譜と演奏から小節別スコアとして算出する検証 CLI。

段3 以降、指標算出の実体は worker/ledgerlines_worker/metrics.py の1つだけ
（設計 9.1）。ここでは本番と同じ compute() / load_est() を呼び、MAESTRO データ
セットに既知の摂動を与えたときの挙動を確認する。指標の説明は worker 側の
docstring を参照すること（重複させない）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 段3 以降、指標算出の実体は worker 側の1つだけ（設計 9.1）。
# ここは検証用の CLI で、本番と同じコードを呼ぶ。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.metrics import compute, load_est, pedal_intervals  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--alignment", type=Path, default=Path("out/alignment"))
    ap.add_argument("--out", type=Path, default=Path("out/metrics"))
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    for align_path in sorted(args.alignment.glob("*.alignment.json")):
        alignment = json.loads(align_path.read_text(encoding="utf-8"))
        name, cond = alignment["name"], alignment["condition"]
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        est_notes, est_pedal = load_est(args.transcribed / f"{name}.{cond}.mid")
        # 参照譜のペダルは拍で持つ（worker の compute が拍を受け取り内部で秒へ直す）。
        ref_pedal_beats = reference.get("pedalIntervalsBeats", [])
        result = compute(reference, est_notes, alignment, est_pedal, ref_pedal_beats)
        result["name"], result["condition"] = name, cond
        (args.out / f"{name}.{cond}.metrics.json").write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )
        rows.append({"name": name, "condition": cond, "overall": result["overallScore"], **result["metrics"]})
        print(
            f"{name}/{cond}: overall={result['overallScore']} " + " ".join(
                f"{k}={v}" for k, v in result["metrics"].items()
            )
        )

    (args.out / "summary.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
