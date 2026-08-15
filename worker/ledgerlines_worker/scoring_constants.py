"""指標の重みと録音品質の閾値。

metrics.py（numpy / pretty_midi に依存）と confidence.py（依存なしの評価ポリシー）の
両方から参照されるため、重い依存を持たない独立モジュールに置く。
"""

from __future__ import annotations

# metrics.md 2.5。articulation は M4 検証で削除し 0.12 を再配分済み。
WEIGHTS = {"pitch": 0.28, "rhythm": 0.28, "tempo": 0.17, "dynamics": 0.17, "pedal": 0.10}

DEAD_RHYTHM = 0.03
DEAD_RHYTHM_DEGRADED = 0.045  # metrics.md:860 劣化録音時
DEGRADED_DYNAMIC_RANGE_DB = 14.0  # metrics.md:860
AGC_DYNAMIC_RANGE_DB = 10.0  # m4-report.md 5.1（AGC はこれ未満で断定できる）
