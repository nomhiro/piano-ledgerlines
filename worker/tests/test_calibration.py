from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "poc" / "scripts"))
sys.path.insert(0, str(ROOT / "worker"))

from calibrate_teacher_evaluation import calibrate, choose_safe_threshold, spearman  # noqa: E402
from ledgerlines_worker.calibration import CalibrationError, load_calibration  # noqa: E402


class CalibrationTests(unittest.TestCase):
    @staticmethod
    def _annotation(teacher_id, rank):
        return {
            "teacherId": teacher_id,
            "overallRank": rank,
            "worstMeasures": [1, 2, 3, 4, 5],
            "metricRanks": {metric: rank for metric in ("pitch", "rhythm", "tempo", "dynamics", "pedal")},
        }

    @classmethod
    def _record(
        cls, take_id, performer, piece, split, rank, confidence, target=False, safe=True
    ):
        return {
            "takeId": take_id,
            "performerId": performer,
            "pieceId": piece,
            "split": split,
            "annotationStatus": "annotated",
            "diagnostics": {
                "referenceNotes": 10,
                "transcribedNotes": 10,
                "matchedNotes": 10,
                "extraNotes": 0,
            },
            "technicalGroundTruth": {
                "noteF1": 1 if safe else 0.5,
                "alignmentF1": 1 if safe else 0.5,
                "safeToScore": {
                    metric: safe
                    for metric in ("pitch", "rhythm", "tempo", "dynamics", "pedal")
                },
            },
            "teacherAnnotations": [
                cls._annotation("t1", rank),
                cls._annotation("t2", rank),
                cls._annotation("t3", rank),
            ],
            "metricConfidence": {
                metric: confidence for metric in ("pitch", "rhythm", "tempo", "dynamics", "pedal")
            },
            "systemOverallRank": rank,
            "systemWorstMeasures": [1, 2, 3, 4, 5],
            "expectedEvaluationStatus": "withheld" if target else "scored",
            "systemEvaluationStatus": "withheld" if target else "scored",
        }

    def test_statistics_and_threshold_are_data_driven(self):
        self.assertAlmostEqual(spearman([1, 2, 3], [10, 20, 30]), 1.0)
        threshold = choose_safe_threshold([(0.2, False), (0.8, True), (0.9, True)])
        self.assertEqual(threshold["minimumConfidence"], 0.8)
        self.assertEqual(threshold["falsePassRate"], 0.0)

    def test_pending_target_dataset_cannot_be_approved(self):
        dataset = json.loads(
            (ROOT / "poc" / "evaluation" / "manifest.json").read_text(encoding="utf-8")
        )
        artifact = calibrate(dataset)
        self.assertFalse(artifact["approved"])
        self.assertFalse(artifact["releaseGates"]["targetTakeRegression"])

    def test_split_leakage_is_rejected(self):
        annotation = {
            "teacherId": "t1",
            "overallRank": 1,
            "worstMeasures": [1, 2, 3, 4, 5],
            "metricRanks": {},
        }
        record = {
            "takeId": "take-1",
            "performerId": "performer",
            "pieceId": "piece",
            "split": "calibration",
            "annotationStatus": "annotated",
            "diagnostics": {
                "referenceNotes": 1,
                "transcribedNotes": 1,
                "matchedNotes": 1,
                "extraNotes": 0,
            },
            "technicalGroundTruth": {"noteF1": 1, "alignmentF1": 1},
            "teacherAnnotations": [
                annotation,
                {**annotation, "teacherId": "t2"},
                {**annotation, "teacherId": "t3"},
            ],
        }
        dataset = {
            "schemaVersion": "1.0",
            "datasetVersion": "test",
            "records": [record, {**record, "takeId": "take-2", "split": "test"}],
        }
        with self.assertRaisesRegex(ValueError, "leakage"):
            calibrate(dataset)

    def test_performer_and_piece_leakage_are_rejected_independently(self):
        base = self._record("take-1", "performer-1", "piece-1", "calibration", 1, 0.9)
        same_performer = self._record(
            "take-2", "performer-1", "piece-2", "test", 2, 0.9
        )
        with self.assertRaisesRegex(ValueError, "performer leakage"):
            calibrate(
                {
                    "schemaVersion": "1.0",
                    "datasetVersion": "test",
                    "records": [base, same_performer],
                }
            )

        same_piece = self._record("take-3", "performer-2", "piece-1", "test", 2, 0.9)
        with self.assertRaisesRegex(ValueError, "piece leakage"):
            calibrate(
                {
                    "schemaVersion": "1.0",
                    "datasetVersion": "test",
                    "records": [base, same_piece],
                }
            )

    def test_loader_rejects_unapproved_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calibration.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "1.0",
                        "calibrationVersion": "test",
                        "datasetHash": "abc",
                        "approved": False,
                        "releaseGates": {"passed": False},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(CalibrationError):
                load_calibration(path)

    def test_loader_rejects_artifact_that_does_not_release_tempo(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calibration.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "1.1",
                        "calibrationVersion": "test",
                        "datasetHash": "abc",
                        "approved": True,
                        "releasedMetrics": ["pitch"],
                        "thresholds": {"pitch": {"minimumConfidence": 0.8}},
                        "releaseGates": {"passed": True},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(CalibrationError, "does not release tempo"):
                load_calibration(path)

    def test_loader_rejects_malformed_released_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calibration.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "1.1",
                        "calibrationVersion": "test",
                        "datasetHash": "abc",
                        "approved": True,
                        "releasedMetrics": {"tempo": False},
                        "thresholds": {"tempo": {"minimumConfidence": 0.8}},
                        "releaseGates": {"passed": True},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(CalibrationError, "invalid released metrics"):
                load_calibration(path)

    def test_duplicate_teacher_annotation_is_rejected(self):
        record = self._record(
            "take-duplicate-teacher",
            "performer",
            "piece",
            "calibration",
            1,
            0.9,
        )
        record["teacherAnnotations"].append(dict(record["teacherAnnotations"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate teacher"):
            calibrate(
                {
                    "schemaVersion": "1.0",
                    "datasetVersion": "test",
                    "records": [record],
                }
            )

    def test_duplicate_system_worst_measure_is_rejected(self):
        record = self._record(
            "take-duplicate-worst",
            "performer",
            "piece",
            "test",
            1,
            0.9,
        )
        record["systemWorstMeasures"] = [1, 2, 3, 4, 4]
        with self.assertRaisesRegex(ValueError, "distinct system worst"):
            calibrate(
                {
                    "schemaVersion": "1.0",
                    "datasetVersion": "test",
                    "records": [record],
                }
            )

    def test_complete_teacher_dataset_produces_loadable_artifact(self):
        dataset = {
            "schemaVersion": "1.0",
            "datasetVersion": "synthetic",
            "records": [
                *[
                    self._record(
                        f"cal-{index}",
                        f"cal-p{index}",
                        f"cal-piece{index}",
                        "calibration",
                        index,
                        0.9 if index % 2 else 0.2,
                        safe=bool(index % 2),
                    )
                    for index in range(1, 21)
                ],
                self._record(
                    "take_980da1b96a3d4bcc9c6c",
                    "test-p1",
                    "test-piece1",
                    "test",
                    1,
                    0.2,
                    target=True,
                    safe=False,
                ),
                *[
                    self._record(
                        f"test-{index}",
                        f"test-p{index}",
                        f"test-piece{index}",
                        "test",
                        index,
                        0.9 if index % 2 else 0.2,
                        safe=bool(index % 2),
                    )
                    for index in range(2, 22)
                ],
            ],
        }
        artifact = calibrate(dataset)
        self.assertTrue(artifact["approved"])
        self.assertEqual(
            set(artifact["releasedMetrics"]),
            {"pitch", "rhythm", "tempo", "dynamics", "pedal"},
        )
        self.assertEqual(artifact["releaseGates"]["teacherRankSpearman"], 1.0)
        self.assertTrue(artifact["releaseGates"]["advancedEvaluationPassed"])
        self.assertTrue(
            all(
                result["passed"]
                for result in artifact["releaseGates"]["confidenceValidation"].values()
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calibration.json"
            path.write_text(json.dumps(artifact), encoding="utf-8")
            loaded = load_calibration(path)
        self.assertEqual(loaded["calibrationVersion"], "synthetic-calibration-v1")

    def test_tempo_can_release_without_publishing_advanced_evaluation(self):
        records = []
        for split, start, stop in (("calibration", 1, 21), ("test", 21, 41)):
            for index in range(start, stop):
                safe = bool(index % 2)
                record = self._record(
                    f"{split}-{index}",
                    f"{split}-performer-{index}",
                    f"{split}-piece-{index}",
                    split,
                    index,
                    0.9 if safe else 0.2,
                    safe=safe,
                )
                record["metricConfidence"] = {"tempo": record["metricConfidence"]["tempo"]}
                record["technicalGroundTruth"]["safeToScore"] = {"tempo": safe}
                record["systemOverallRank"] = None
                record.pop("systemWorstMeasures")
                records.append(record)
        target = self._record(
            "take_980da1b96a3d4bcc9c6c",
            "target-performer",
            "target-piece",
            "test",
            41,
            0.2,
            target=True,
            safe=False,
        )
        target["metricConfidence"] = {"tempo": 0.2}
        target["technicalGroundTruth"]["safeToScore"] = {"tempo": False}
        target["systemOverallRank"] = None
        target.pop("systemWorstMeasures")
        records.append(target)

        artifact = calibrate(
            {
                "schemaVersion": "1.0",
                "datasetVersion": "tempo-only",
                "records": records,
            }
        )

        self.assertTrue(artifact["approved"])
        self.assertEqual(artifact["releasedMetrics"], ["tempo"])
        self.assertFalse(artifact["releaseGates"]["advancedEvaluationPassed"])


if __name__ == "__main__":
    unittest.main()
