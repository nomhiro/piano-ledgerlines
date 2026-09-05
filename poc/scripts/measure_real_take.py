"""実録音1件を採譜し、extra 分類の内訳と τ 候補ごとの pitch を測る（設計 9.3 の脚2）。

フェーズ1（摂動、poc/scripts/sweep_pitch_tau.py）は ground truth MIDI に直接摂動を
与えるため採譜を通さない。したがって分類が除去対象とするアーティファクト
（二重検出・倍音ゴースト・スプリアス・ペダル残響）が1件も存在しない。ここは実在の
アーティファクトに対する分類の効果を測る唯一の脚である。

**1件なので分布は語れない。τ 候補の裏付けにのみ使う（設計 9.3）。**

指標の式は worker の metrics.compute をそのまま使う（設計 9.1）。候補の切り替えは
モジュール変数（metrics_mod.TAU_PITCH / metrics_mod.W_EXTRA）の差し替えだけで行い、
式を再実装しない。

torch と採譜チェックポイントが必要なので、ワーカーコンテナ内で実行する:

    docker compose -f docker-compose.azure-local.yml run --rm --no-deps \
      -v "${PWD}/poc:/app/poc" -v "${PWD}/.data:/app/.data" -v "${PWD}/out:/app/out" \
      --entrypoint python worker /app/poc/scripts/measure_real_take.py \
      --audio /app/.data/audio/<takeId>/original.webm \
      --reference /app/.data/derived/<songId>/reference.json

**worker/ のコードを変更した後は必ずイメージを再ビルドすること。** 再ビルドしないと
分類ロジックが入っていない古いコードを測ることになり、測定が空振りする。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# リポジトリのチェックアウトでは worker/ledgerlines_worker、ワーカーイメージでは
# /app/ledgerlines_worker（worker/Dockerfile が WORKDIR=/app 直下に COPY する）。
# 実行時の cwd に依存させず、両方を候補として先に見つかった方を使う。
for _candidate in (Path(__file__).resolve().parents[2] / "worker", Path("/app")):
    if (_candidate / "ledgerlines_worker").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from ledgerlines_worker import metrics as metrics_mod  # noqa: E402
from ledgerlines_worker import preprocess as preprocess_mod  # noqa: E402
from ledgerlines_worker import transcribe as transcribe_mod  # noqa: E402
from ledgerlines_worker.align import align  # noqa: E402
from ledgerlines_worker.metrics import load_est  # noqa: E402

TAU_CANDIDATES = [0.15, 0.20, 0.40, 0.60, 0.80, 1.00, 1.20]
W_EXTRA_CANDIDATES = [0.3, 0.5, 0.7]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", type=Path, required=True, help="実録音（webm / wav）")
    ap.add_argument("--reference", type=Path, required=True, help="実データの reference.json")
    ap.add_argument("--work", type=Path, default=Path("out/real-take"))
    ap.add_argument("--out", type=Path, default=Path("out/metrics/real-take.json"))
    ap.add_argument(
        "--reuse-midi",
        action="store_true",
        help="--work に採譜済み MIDI があれば再利用する（採譜は RTF 1.2 前後で数分かかる）",
    )
    args = ap.parse_args()

    args.work.mkdir(parents=True, exist_ok=True)
    reference = json.loads(args.reference.read_text(encoding="utf-8"))

    # 前処理と採譜は本番と同じ呼び方をする（worker_main.py:294-297 と同一）。
    # preprocess は dict を返し ["path"] に前処理済み wav のパスが入る。
    # transcribe は書き出し先のパスを受け取る（戻り値ではなく引数で渡す）。
    midi_path = args.work / "transcription.mid"
    if args.reuse_midi and midi_path.exists():
        print(f"reusing existing transcription: {midi_path}")
        pre = None
    else:
        pre = preprocess_mod.preprocess(args.audio, args.work)
        print(f"preprocessed: {pre['path']} durationSec={pre.get('durationSec')}")
        transcribe_mod.transcribe(pre["path"], midi_path)
        print(f"transcribed: {midi_path}")

    est_notes, est_pedal = load_est(midi_path)
    alignment = align(reference, est_notes, mode="jump", est_pedal=est_pedal)

    breakdown = {
        "audio": str(args.audio),
        "reference": str(args.reference),
        # --reuse-midi で採譜を飛ばした場合は preprocess を通らないので null になる。
        "durationSec": (pre or {}).get("durationSec"),
        "referenceNotes": len(reference["notes"]),
        "transcribedNotes": len(est_notes),
        "matchedNotes": len(alignment["pairs"]),
        "missedNotes": len(alignment["missed"]),
        # align() は不一致を missed（DTW に覆われた区間の未一致、align.py:274）と
        # unplayed（どの run にも覆われなかった参照音符、align.py:277）に分け、超過側からは
        # retake（同じ参照音符に後の run が別の est を割り当てた分の旧 est、align.py:263-265）
        # を extra から除く。この3つを出さないと
        #   参照 = matched + missed + unplayed / 採譜 = matched + extra + retake
        # の両辺が閉じず、内訳を監査できない。
        "unplayedNotes": len(alignment["unplayed"]),
        "retakeNotes": len(alignment["retakes"]),
        "takes": alignment.get("takes"),
        "extraNotes": len(alignment["extra"]),
        "extraNoiseNotes": len(alignment["extraNoise"]),
        "extraPlayedNotes": len(alignment["extraPlayed"]),
        "extraNoiseByReason": alignment["extraNoiseByReason"],
        "noiseShare": (
            len(alignment["extraNoise"]) / len(alignment["extra"]) if alignment["extra"] else None
        ),
    }

    grid = []
    for tau in TAU_CANDIDATES:
        for w_extra in W_EXTRA_CANDIDATES:
            metrics_mod.TAU_PITCH = tau
            metrics_mod.W_EXTRA = w_extra
            result = metrics_mod.compute(
                reference,
                est_notes,
                alignment,
                est_pedal,
                # 実データの reference.json は旧形式だとこのキーを持たないので get で読む
                # （worker_main.py も同じく欠損時は空リストに degrade させる）。
                reference.get("pedalIntervalsBeats", []),
                # 第6引数 degraded は意図的に省略している（既定の False）。degraded が効くのは
                # rhythm のデッドゾーン（metrics.py:117 の dead_rhythm）だけで pitch には
                # 影響しないため、pitch を測るこのハーネスでは production と同値になる。
            )
            grid.append(
                {"tau": tau, "wExtra": w_extra, "pitch": result["metrics"]["pitch"]}
            )
            print(f"tau={tau} w_extra={w_extra} pitch={result['metrics']['pitch']}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"breakdown": breakdown, "grid": grid}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n" + json.dumps(breakdown, ensure_ascii=False, indent=2))
    print("NOTE: one recording cannot describe a distribution (design 9.3).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
