"""参照譜（拍単位）と採譜結果（秒単位）の音符対応を求める検証 CLI。

段3 以降、アライメントの実体は worker/ledgerlines_worker/align.py の1つだけ
（設計 9.1）。ここでは本番と同じ align() / load_est() を呼び、MAESTRO データ
セットに既知の摂動を与えたときの挙動を確認する。アルゴリズムの説明は worker
側の docstring を参照すること（重複させない）。

出力は {refIndex, estIndex} のペア列と、未対応音符の一覧。
未対応は「弾かれた範囲での弾き落とし（missed）」と
「そもそも弾いていない範囲（unplayed）」を区別する。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 段3 以降、アルゴリズムの実体は worker 側の1つだけ（設計 9.1）。
# ここは検証用の CLI で、本番と同じコードを呼ぶ。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.align import JUMP_PENALTY, align, load_est  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--out", type=Path, default=Path("out/alignment"))
    ap.add_argument("--conditions", nargs="*", default=["clean", "room", "phone", "phone_agc"])
    ap.add_argument("--window", type=float, default=1.0, help="近傍探索の窓（秒）")
    ap.add_argument("--mode", choices=["strict", "jump"], default="jump")
    ap.add_argument("--jump-penalty", type=float, default=JUMP_PENALTY)
    ap.add_argument("--tag", default="", help="出力ファイル名に付ける識別子")
    ap.add_argument("--pieces", nargs="*", default=None)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    suffix = f".{args.tag}" if args.tag else ""
    summary = []
    for ref_path in sorted(args.reference.glob("*.reference.json")):
        name = ref_path.name.split(".")[0]
        if args.pieces and name not in args.pieces:
            continue
        reference = json.loads(ref_path.read_text(encoding="utf-8"))
        for cond in args.conditions:
            mid = args.transcribed / f"{name}.{cond}.mid"
            if not mid.exists():
                continue
            est = load_est(mid)
            result = align(reference, est, args.window, args.mode, args.jump_penalty)
            result["name"] = name
            result["condition"] = cond
            (args.out / f"{name}.{cond}{suffix}.alignment.json").write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8"
            )
            row = {
                "name": name,
                "condition": cond,
                "refNotes": len(reference["notes"]),
                "estNotes": len(est),
                "pairs": len(result["pairs"]),
                "missed": len(result["missed"]),
                "unplayed": len(result.get("unplayed", [])),
                "retakes": len(result.get("retakes", [])),
                "extra": len(result["extra"]),
                "extraNoise": len(result.get("extraNoise", [])),
                "extraPlayed": len(result.get("extraPlayed", [])),
                "takes": result.get("takes", 1),
            }
            summary.append(row)
            print(
                f"{name}/{cond}: ref={row['refNotes']} est={row['estNotes']} "
                f"pairs={row['pairs']} missed={row['missed']} unplayed={row['unplayed']} "
                f"retake={row['retakes']} extra={row['extra']} "
                f"(noise={row['extraNoise']} played={row['extraPlayed']}) takes={row['takes']}"
            )

    (args.out / f"summary{suffix}.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
