"""S5: 指摘生成。

metrics.md の設計思想（誤り/揺らぎ/表現を区別し、行動につながる粒度で出す）に
沿った簡易実装。小節別スコアが閾値を下回った指標をまとめ、連続する小節は
1件の指摘に集約する。M5縦串向けの最小実装であり、AI講評（S6）による
自然文の指摘生成とは別レイヤー。
"""

from __future__ import annotations

from typing import Any

SEVERITY_THRESHOLDS = [(40.0, "high"), (65.0, "medium"), (80.0, "low")]

METRIC_ISSUE_KIND = {
    "pitch": "missed-note",
    "rhythm": "timing",
    "tempo": "tempo",
    "dynamics": "dynamics",
    "pedal": "pedal",
}

METRIC_LABEL = {
    "pitch": "音程",
    "rhythm": "リズム",
    "tempo": "テンポ",
    "dynamics": "ダイナミクス",
    "pedal": "ペダル",
}


def _severity(score: float) -> str | None:
    for threshold, sev in SEVERITY_THRESHOLDS:
        if score < threshold:
            return sev
    return None


def generate_issues(measure_scores: list[dict[str, Any]]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    issue_id = 1
    for metric, kind in METRIC_ISSUE_KIND.items():
        run: list[int] = []
        run_scores: list[float] = []

        def flush():
            nonlocal issue_id
            if not run:
                return
            avg = sum(run_scores) / len(run_scores)
            sev = _severity(avg)
            if sev is None:
                return
            issues.append(
                {
                    "id": f"iss_{issue_id}",
                    "kind": kind,
                    "severity": sev,
                    "measures": [run[0], run[-1]] if len(run) > 1 else [run[0]],
                    "summary": f"{run[0]}〜{run[-1]}小節目の{METRIC_LABEL[metric]}が平均{avg:.0f}点です。"
                    if len(run) > 1
                    else f"{run[0]}小節目の{METRIC_LABEL[metric]}が{avg:.0f}点です。",
                    "metric": metric,
                }
            )
            issue_id += 1

        prev_measure = None
        for ms in measure_scores:
            score = ms["metrics"].get(metric)
            evaluation = ms.get("metricEvaluations", {}).get(metric)
            m = ms["measure"]
            if (
                score is not None
                and evaluation is not None
                and evaluation.get("status") == "scored"
                and _severity(score) is not None
            ):
                if prev_measure is not None and m != prev_measure + 1:
                    flush()
                    run, run_scores = [], []
                run.append(m)
                run_scores.append(score)
                prev_measure = m
            else:
                flush()
                run, run_scores = [], []
                prev_measure = None
        flush()

    issues.sort(key=lambda i: (-{"high": 2, "medium": 1, "low": 0}[i["severity"]], i["measures"][0]))
    return issues
