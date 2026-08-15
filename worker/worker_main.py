"""解析ワーカー CLI エントリポイント。

Next.js API (child_process.spawn) から2つのモードで呼ばれる。

  --mode reference --data-dir <dir> --song-id <id>
      S1: アップロード済み MusicXML から reference.json を生成し、
      songs/{songId}.json を更新する（同期呼び出し想定、api.md 5.1）。

  --mode analyze --data-dir <dir> --take-id <id>
      S0〜S5: テイクの音声を解析し、takes/{takeId}.json に結果を書き込む
      （非同期呼び出し想定、api.md 5.2/5.3）。takeドキュメントの status を
      段階的に更新するので、Next.js側はファイルをポーリングしてSSEに変換できる。

データレイアウトは docs/design/data-model.md 2.2 のBlobパス設計に倣う
（ローカルではファイルシステムで代用）。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import traceback
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path

def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def song_path(data_dir: Path, song_id: str) -> Path:
    return data_dir / "songs" / f"{song_id}.json"


def take_path(data_dir: Path, take_id: str) -> Path:
    return data_dir / "takes" / f"{take_id}.json"


def update_take(data_dir: Path, take_id: str, **fields) -> dict:
    path = take_path(data_dir, take_id)
    doc = read_json(path)
    doc.update(fields)
    doc["updatedAt"] = now_iso()
    write_json(path, doc)
    return doc


def materialize_preview_score(score_path: Path) -> Path | None:
    if score_path.suffix.lower() in {".musicxml", ".xml"}:
        return score_path
    if score_path.suffix.lower() != ".mxl":
        return None

    with zipfile.ZipFile(score_path) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        rootfile = next(
            element.attrib["full-path"]
            for element in container.iter()
            if element.tag.endswith("rootfile") and "full-path" in element.attrib
        )
        target = score_path.parent / "preview.musicxml"
        target.write_bytes(archive.read(rootfile))
        return target


def without_repeat_markers(score_path: Path) -> Path:
    tree = ET.parse(score_path)
    for parent in tree.iter():
        for child in list(parent):
            if child.tag.rsplit("}", 1)[-1] in {"repeat", "ending"}:
                parent.remove(child)
    target = score_path.with_name("preview-playback.musicxml")
    tree.write(target, encoding="utf-8", xml_declaration=True)
    return target


def generate_preview_assets(score_path: Path) -> tuple[str | None, str | None, list[dict]]:
    from music21 import converter

    warnings: list[dict] = []
    preview_score_name = None
    preview_midi_name = None
    try:
        preview_score = materialize_preview_score(score_path)
        preview_score_name = preview_score.name if preview_score else None
        if not preview_score:
            raise ValueError("MIDI入力からは楽譜描画用のMusicXMLを生成できません。")
        preview_midi = score_path.parent / "preview.mid"
        playback_source = None
        try:
            converter.parse(str(score_path)).write("midi", fp=str(preview_midi))
        except Exception as exc:
            if "badly formed repeats" not in str(exc):
                raise
            playback_source = without_repeat_markers(preview_score)
            converter.parse(str(playback_source)).write("midi", fp=str(preview_midi))
        finally:
            if playback_source:
                playback_source.unlink(missing_ok=True)
        preview_midi_name = preview_midi.name
    except Exception as exc:  # noqa: BLE001
        warnings.append(
            {
                "code": "PREVIEW_MIDI_UNAVAILABLE",
                "message": f"楽譜プレビュー用MIDIを生成できませんでした: {exc}",
            }
        )
    return preview_score_name, preview_midi_name, warnings


def run_reference(data_dir: Path, song_id: str) -> int:
    from ledgerlines_worker import reference as reference_mod

    song = read_json(song_path(data_dir, song_id))
    score_files = [
        path for path in (data_dir / "scores" / song_id).glob("score.*")
        if path.suffix.lower() in {".musicxml", ".xml", ".mxl", ".mid", ".midi"}
    ]
    if not score_files:
        raise FileNotFoundError(f"score file missing for {song_id}")
    xml_path = score_files[0]
    try:
        ref = reference_mod.build_reference(xml_path, tempo_bpm=song.get("targetTempo") or 96.0)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        song["status"] = "awaiting_score"
        song["lastScoreError"] = str(exc)
        write_json(song_path(data_dir, song_id), song)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    write_json(data_dir / "derived" / song_id / "reference.json", ref)
    preview_score_name, preview_midi_name, preview_warnings = generate_preview_assets(xml_path)
    warnings = [*ref.get("warnings", []), *preview_warnings]

    song.update(
        {
            "status": "ready",
            "measureCount": ref["measureCount"],
            "scoreMeasureCount": ref["measureCount"],
            "keySignature": ref.get("keySignature"),
            "timeSignature": ref.get("timeSignature"),
            "detectedTempo": ref.get("estimatedTempo"),
            "hasRepeats": False,
            "warnings": warnings,
            "previewScoreFileName": preview_score_name,
            "previewMidiFileName": preview_midi_name,
            "updatedAt": now_iso(),
        }
    )
    write_json(song_path(data_dir, song_id), song)
    print(
        json.dumps(
            {
                "ok": True,
                "songId": song_id,
                "status": song["status"],
                "measureCount": song["measureCount"],
                "scoreMeasureCount": song["scoreMeasureCount"],
                "keySignature": song["keySignature"],
                "timeSignature": song["timeSignature"],
                "detectedTempo": song["detectedTempo"],
                "hasRepeats": song["hasRepeats"],
                "warnings": song["warnings"],
            },
            ensure_ascii=False,
        )
    )
    return 0


def run_omr(data_dir: Path, song_id: str) -> int:
    song_file = song_path(data_dir, song_id)
    song = read_json(song_file)
    score_dir = data_dir / "scores" / song_id
    source_files = list(score_dir.glob("score.pdf"))
    if len(source_files) != 1:
        raise FileNotFoundError(f"PDF score file missing for {song_id}")

    source = source_files[0]
    output_dir = data_dir / "work" / song_id / "audiveris"
    output_dir.mkdir(parents=True, exist_ok=True)
    command_value = os.environ.get("AUDIVERIS_COMMAND", "audiveris")
    command = [command_value] if Path(command_value).is_file() else shlex.split(command_value, posix=False)
    timeout = int(os.environ.get("AUDIVERIS_TIMEOUT_SECONDS", "300"))

    try:
        result = subprocess.run(
            [*command, "-batch", "-export", "-output", str(output_dir), str(source)],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"Audiveris exited with code {result.returncode}")
        generated = [
            path for path in output_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in {".musicxml", ".xml", ".mxl"}
        ]
        if len(generated) != 1:
            raise RuntimeError("Audiveris did not produce exactly one MusicXML file")
        target = score_dir / f"score{generated[0].suffix.lower()}"
        shutil.copyfile(generated[0], target)
        preview_score_name, preview_midi_name, preview_warnings = generate_preview_assets(target)
        song.update(
            {
                "status": "reviewing_score",
                "scoreFileName": target.name,
                "sourceScoreFileName": song.get("sourceScoreFileName") or source.name,
                "scoreSource": "pdf",
                "omrEngine": "audiveris",
                "omrError": None,
                "lastScoreError": None,
                "previewScoreFileName": preview_score_name,
                "previewMidiFileName": preview_midi_name,
                "warnings": preview_warnings,
                "updatedAt": now_iso(),
            }
        )
        write_json(song_file, song)
        print(json.dumps({"ok": True, "songId": song_id, "status": song["status"]}))
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        song.update({"status": "omr_failed", "omrEngine": "audiveris", "omrError": str(exc), "updatedAt": now_iso()})
        write_json(song_file, song)
        print(json.dumps({"ok": False, "songId": song_id, "error": str(exc)}))
        return 1


def run_analyze(data_dir: Path, take_id: str, on_update=None) -> int:
    from ledgerlines_worker import align as align_mod
    from ledgerlines_worker import calibration as calibration_mod
    from ledgerlines_worker import confidence as confidence_mod
    from ledgerlines_worker import metrics as metrics_mod
    from ledgerlines_worker import preprocess as preprocess_mod
    from ledgerlines_worker import transcribe as transcribe_mod
    from ledgerlines_worker.issues import generate_issues
    from ledgerlines_worker.scoring_constants import DEGRADED_DYNAMIC_RANGE_DB

    take = read_json(take_path(data_dir, take_id))
    song_id = take["songId"]

    def update(fields: dict) -> dict:
        doc = update_take(data_dir, take_id, **fields)
        if on_update:
            on_update(doc)
        return doc

    try:
        update({"status": "transcribing", "progress": 0.1})

        audio_dir = data_dir / "audio" / take_id
        audio_files = list(audio_dir.glob("original.*"))
        if not audio_files:
            raise preprocess_mod.PreprocessError("VALIDATION_FAILED", "audio blob missing")
        src_audio = audio_files[0]

        work_dir = data_dir / "work" / take_id
        pre = preprocess_mod.preprocess(src_audio, work_dir)

        midi_path = data_dir / "derived-takes" / take_id / "transcription.mid"
        transcribe_mod.transcribe(pre["path"], midi_path)

        update({"status": "aligning", "progress": 0.55})

        reference = read_json(data_dir / "derived" / song_id / "reference.json")
        est_notes = align_mod.load_est(midi_path)
        alignment = align_mod.align(reference, est_notes, mode="jump")
        write_json(data_dir / "derived-takes" / take_id / "alignment.json", alignment)

        update({"status": "scoring", "progress": 0.8})

        est_notes_full, est_pedal = metrics_mod.load_est(midi_path)
        dynamic_range_db = pre.get("dynamicRangeDb")
        degraded = (
            dynamic_range_db is not None
            and dynamic_range_db < DEGRADED_DYNAMIC_RANGE_DB
        )
        ref_pedal_beats = reference.get("pedalIntervalsBeats") or []
        result = metrics_mod.compute(
            reference,
            est_notes_full,
            alignment,
            est_pedal,
            ref_pedal_beats=ref_pedal_beats,
            degraded=degraded,
        )
        calibration = calibration_mod.load_calibration()
        result = confidence_mod.apply_fail_closed_policy(
            result,
            reference,
            alignment,
            len(est_notes_full),
            calibration,
            dynamic_range_db=dynamic_range_db,
            pedal_reference_available=bool(ref_pedal_beats),
        )

        if result.get("alignmentBelowFloor"):
            update({
                "status": "failed",
                "failure": {
                    "code": "ALIGN_FAILED",
                    "message": result["evaluation"]["reason"],
                },
                "analysis": {
                    "pipelineVersion": "0.3.0-m5-metric-policy",
                    "diagnostics": result["diagnostics"],
                },
            })
            print(json.dumps({"ok": False, "code": "ALIGN_FAILED", "takeId": take_id}))
            return 1

        issues = generate_issues(result["measureScores"])

        update({
            "status": "completed",
            "progress": 1.0,
            "overallScore": result["overallScore"],
            "metrics": result["metrics"],
            "metricConfidence": result["metricConfidence"],
            "metricEvaluations": result["metricEvaluations"],
            "metricsNAReason": result["metricsNAReason"],
            "evaluation": result["evaluation"],
            "measureScores": result["measureScores"],
            "issues": issues,
            "failure": None,
            "aiReview": None,  # S6 (Microsoft Foundry) は未実装。後続フェーズで差し込む。
            "analysis": {
                "pipelineVersion": "0.3.0-m5-metric-policy",
                "preprocess": {**pre, "path": str(pre["path"])},
                "baseTempo": result["baseTempo"],
                "takes": alignment.get("takes"),
                "diagnostics": result["diagnostics"],
            },
        })
        print(json.dumps({"ok": True, "takeId": take_id, "overallScore": result["overallScore"]}))
        return 0
    except preprocess_mod.PreprocessError as exc:
        update({"status": "failed", "failure": {"code": exc.code, "message": exc.message}})
        print(json.dumps({"ok": False, "code": exc.code, "error": exc.message}))
        return 1
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        update({"status": "failed", "failure": {"code": "INTERNAL", "message": str(exc)}})
        print(json.dumps({"ok": False, "code": "INTERNAL", "error": str(exc)}))
        return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["omr", "reference", "analyze"], required=True)
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--song-id")
    ap.add_argument("--take-id")
    args = ap.parse_args()

    if args.mode in {"omr", "reference"}:
        if not args.song_id:
            print("song-id required for reference mode", file=sys.stderr)
            return 2
        if args.mode == "omr":
            return run_omr(args.data_dir, args.song_id)
        return run_reference(args.data_dir, args.song_id)

    if not args.take_id:
        print("take-id required for analyze mode", file=sys.stderr)
        return 2
    return run_analyze(args.data_dir, args.take_id)


if __name__ == "__main__":
    raise SystemExit(main())
