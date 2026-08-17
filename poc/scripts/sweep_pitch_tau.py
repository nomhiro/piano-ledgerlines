"""(TAU_PITCH, W_EXTRA) の候補を掃引し、設計 5.1 の合格条件4項目を判定する。

指標の式は worker の metrics.compute をそのまま使う（設計 9.1）。ここでは
モジュール変数を差し替えて候補を切り替えるだけで、式を再実装しない。

**フェーズ1 は採譜を通さないため、extra 分類が実在のアーティファクトを除去できるかは
測れない（設計 9.3）。ここで測るのは弁別力だけである。**

摂動の条件名は poc/scripts/perturb.py の PERTURBATIONS が定義する
none / drop05 / drop15 / add05 / add15 / jitter30 / jitter80 / tempo05 / tempo15 /
flat50 / flat90 / nopedal の12種だが、実際に out/transcribed/ に書き出されるファイル名は
`pieceNN.p_<condition>.mid`（perturb.py:141 の `f"{piece['name']}.p_{label}.mid"`）であり、
ファイル名から取れる条件トークンには `p_` が前置される（`p_none` / `p_drop05` / `p_add05`）。
evaluate() は設計 5.1 の条件名（`p_` なし）で判定するため、normalize_condition() で
先頭の `p_` を剥がしてから渡す。evaluate() 側を perturb.py のファイル命名（`p_` 接頭辞）
に結合させない — 命名が変わっても evaluate() の接頭辞判定は変更不要にする。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker import metrics as metrics_mod  # noqa: E402
from ledgerlines_worker.align import align  # noqa: E402
from ledgerlines_worker.metrics import load_est  # noqa: E402

TAU_CANDIDATES = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40]
W_EXTRA_CANDIDATES = [0.3, 0.5, 0.7]


def normalize_condition(condition: str) -> str:
    """perturb.py は `p_` 接頭辞付きで書き出す（perturb.py:141）。
    設計 5.1 の条件名（none / drop05 / add05 ...）に合わせて剥がす。"""
    return condition[2:] if condition.startswith("p_") else condition


def rate_of(condition: str) -> float | None:
    """条件名から摂動率を取り出す（例 'drop05' -> 0.05）。取れなければ None。"""
    m = re.search(r"(\d+)$", condition)
    return int(m.group(1)) / 100.0 if m else None


def pitch_for(reference: dict, mid_path: Path, tau: float, w_extra: float) -> float | None:
    est_notes, est_pedal = load_est(mid_path)
    alignment = align(reference, est_notes, mode="jump", est_pedal=est_pedal)
    metrics_mod.TAU_PITCH = tau
    metrics_mod.W_EXTRA = w_extra
    result = metrics_mod.compute(
        reference,
        est_notes,
        alignment,
        est_pedal,
        reference.get("pedalIntervalsBeats", []),
    )
    return result["metrics"]["pitch"]


def evaluate(rows: list[dict]) -> dict:
    """設計 5.1 の4条件を判定する。rows は {condition, pitch} の列で、
    condition は normalize_condition() 済み（`p_` なし）を前提とする。"""
    by_cond = {r["condition"]: r["pitch"] for r in rows if r["pitch"] is not None}
    none_pitch = by_cond.get("none")

    def family(prefix: str) -> list[tuple[float, float]]:
        out = []
        for r in rows:
            if r["pitch"] is None or not r["condition"].startswith(prefix):
                continue
            rate = rate_of(r["condition"])
            if rate is not None:
                out.append((rate, r["pitch"]))
        return sorted(out)

    drops, adds = family("drop"), family("add")
    c1 = none_pitch is not None and none_pitch >= 90.0
    c2 = len(drops) >= 2 and drops[0][1] > drops[-1][1]
    c3 = bool(adds) and none_pitch is not None and adds[0][1] < none_pitch
    c4 = all(
        all(b[1] <= a[1] + 1e-9 for a, b in zip(fam, fam[1:]))
        for fam in (drops, adds)
        if len(fam) >= 2
    )
    return {
        "nonePitch": none_pitch,
        "c1_none_at_least_90": c1,
        "c2_drop_separates": c2,
        "c3_add_lowers": c3,
        "c4_monotonic": c4,
        "passed": all([c1, c2, c3, c4]),
        "drops": drops,
        "adds": adds,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--out", type=Path, default=Path("out/metrics/pitch-sweep.json"))
    args = ap.parse_args()

    references = {
        p.name.split(".")[0]: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(args.reference.glob("*.reference.json"))
    }
    if not references:
        print("no references found; run make_reference.py first")
        return 1

    results = []
    for tau in TAU_CANDIDATES:
        for w_extra in W_EXTRA_CANDIDATES:
            rows = []
            for name, reference in references.items():
                for mid in sorted(args.transcribed.glob(f"{name}.*.mid")):
                    raw_condition = mid.name[len(name) + 1 : -len(".mid")]
                    rows.append(
                        {
                            "name": name,
                            "condition": normalize_condition(raw_condition),
                            "rawCondition": raw_condition,
                            "pitch": pitch_for(reference, mid, tau, w_extra),
                        }
                    )
            # 曲ごとの差を平均して条件単位に畳む
            by_cond: dict[str, list[float]] = {}
            for r in rows:
                if r["pitch"] is not None:
                    by_cond.setdefault(r["condition"], []).append(r["pitch"])
            mean_rows = [
                {"condition": c, "pitch": sum(v) / len(v)} for c, v in sorted(by_cond.items())
            ]
            verdict = evaluate(mean_rows)
            results.append({"tau": tau, "wExtra": w_extra, **verdict, "rows": mean_rows})
            print(
                f"tau={tau} w_extra={w_extra} none={verdict['nonePitch']} "
                f"c1={verdict['c1_none_at_least_90']} c2={verdict['c2_drop_separates']} "
                f"c3={verdict['c3_add_lowers']} c4={verdict['c4_monotonic']} "
                f"=> {'PASS' if verdict['passed'] else 'fail'}"
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = [r for r in results if r["passed"]]
    print(f"\n{len(passed)}/{len(results)} candidate(s) passed all four criteria")
    print("NOTE: phase 1 does not exercise transcription, so it cannot show whether the")
    print("      extra classifier removes real artifacts (design 9.3). That is leg 2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
