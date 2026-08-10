"""Load only approved, reproducible teacher-calibration artifacts."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

ARTIFACT_SCHEMA_VERSION = "1.1"


class CalibrationError(ValueError):
    pass


def load_calibration(path: Path | None = None) -> dict[str, Any] | None:
    if path is None and os.environ.get("LEDGERLINES_ENABLE_CALIBRATED_SCORES", "").lower() != "true":
        return None
    configured = path or (
        Path(os.environ["LEDGERLINES_CALIBRATION_FILE"])
        if os.environ.get("LEDGERLINES_CALIBRATION_FILE")
        else None
    )
    if configured is None:
        return None
    body = configured.read_bytes()
    artifact = json.loads(body)
    if artifact.get("schemaVersion") != ARTIFACT_SCHEMA_VERSION:
        raise CalibrationError("unsupported calibration artifact schema")
    if artifact.get("approved") is not True:
        raise CalibrationError("calibration artifact is not approved")
    gates = artifact.get("releaseGates", {})
    if not gates.get("passed"):
        raise CalibrationError("calibration release gates did not pass")
    if not artifact.get("datasetHash") or not artifact.get("calibrationVersion"):
        raise CalibrationError("calibration artifact is missing provenance")
    released_metrics = artifact.get("releasedMetrics")
    valid_metrics = {"pitch", "rhythm", "tempo", "dynamics", "pedal"}
    if (
        not isinstance(released_metrics, list)
        or not released_metrics
        or any(not isinstance(metric, str) or metric not in valid_metrics for metric in released_metrics)
        or len(set(released_metrics)) != len(released_metrics)
    ):
        raise CalibrationError("calibration artifact has invalid released metrics")
    if "tempo" not in released_metrics:
        raise CalibrationError("calibration artifact does not release tempo")
    tempo_threshold = (
        (artifact.get("thresholds", {}).get("tempo") or {}).get("minimumConfidence")
    )
    if (
        not isinstance(tempo_threshold, (int, float))
        or isinstance(tempo_threshold, bool)
        or not 0 <= tempo_threshold <= 1
    ):
        raise CalibrationError("calibration artifact has no valid tempo threshold")
    artifact["artifactHash"] = hashlib.sha256(body).hexdigest()
    return artifact
