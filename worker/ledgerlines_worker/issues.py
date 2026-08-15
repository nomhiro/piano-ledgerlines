"""S5: 指摘生成。

metrics.md の設計思想（誤り/揺らぎ/表現を区別し、行動につながる粒度で出す）に
沿った簡易実装。小節別スコアが閾値を下回った指標をまとめ、連続する小節は
1件の指摘に集約する。M5縦串向けの最小実装であり、AI講評（S6）による
自然文の指摘生成とは別レイヤー。
"""

from __future__ import annotations

from typing import Any

# 未較正の設計値。教師評価データによる較正は行われていない（metrics.md 8.2 は「未」）ので、
# 「40点未満は重大」という区切りには実測の裏付けが無い。指標別ポリシーで rhythm/tempo/
# dynamics/pedal が scored になったことでこの閾値が初めて実効化された。指標そのものの
# 頑健性を指す `ROBUSTNESS_VALIDATED`（confidence.py）とは別物であり、こちらは未検証。
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

PRACTICE_ACTION = {
    "pitch": "該当小節を片手ずつ、和音は構成音を確認してからゆっくり合わせます。",
    "rhythm": "メトロノームを鳴らさずに拍を数え、該当小節を短い単位で反復します。",
    "tempo": "前後1小節を含め、一定の脈を保てる速度から段階的に上げます。",
    "dynamics": "主旋律だけを歌ってから、伴奏を小さく加えて録音を聴き比べます。",
    "pedal": "和声が変わる位置で一度ペダルを離し、濁りが消える踏み替えを確認します。",
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
        run_confidence: list[float] = []

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
                    "confidence": round(min(run_confidence), 4) if run_confidence else None,
                    # 「較正済み」と書いてはならない。教師評価データによる較正は存在せず
                    # （metrics.md 8.2）、採点の根拠は録音条件への頑健性の実測である。
                    "observation": (
                        f"{METRIC_LABEL[metric]}のスコアが連続して低下しています。"
                        if len(run) > 1
                        else f"{METRIC_LABEL[metric]}のスコアが低下しています。"
                    ),
                    "evidence": {
                        "averageScore": round(avg, 2),
                        "measureScores": [round(value, 2) for value in run_scores],
                    },
                    "practiceAction": PRACTICE_ACTION[metric],
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
                    run, run_scores, run_confidence = [], [], []
                run.append(m)
                run_scores.append(score)
                if evaluation.get("confidence") is not None:
                    run_confidence.append(float(evaluation["confidence"]))
                prev_measure = m
            else:
                flush()
                run, run_scores, run_confidence = [], [], []
                prev_measure = None
        flush()

    issues.sort(key=lambda i: (-{"high": 2, "medium": 1, "low": 0}[i["severity"]], i["measures"][0]))
    return issues
