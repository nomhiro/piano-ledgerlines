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
import sys
import traceback
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


def run_reference(data_dir: Path, song_id: str) -> int:
    from ledgerlines_worker import reference as reference_mod

    song = read_json(song_path(data_dir, song_id))
    score_files = list((data_dir / "scores" / song_id).glob("score.*"))
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

    song.update(
        {
            "status": "ready",
            "measureCount": ref["measureCount"],
            "scoreMeasureCount": ref["measureCount"],
            "keySignature": ref.get("keySignature"),
            "timeSignature": ref.get("timeSignature"),
            "detectedTempo": ref.get("estimatedTempo"),
            "hasRepeats": False,
            "warnings": ref.get("warnings", []),
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


def mask_unavailable_pedal(result: dict) -> dict:
    """reference.py は現状MusicXMLからペダル記号を抽出していないため、
    pedal指標は「測定不能(N/A)」として扱い、加重平均から除外する。
    metrics.mdの「nullと欠損の区別」(api.md P4)に沿った処理。
    """
    from ledgerlines_worker.metrics import WEIGHTS

    for ms in result["measureScores"]:
        ms["metrics"]["pedal"] = None
        active = {k: w for k, w in WEIGHTS.items() if ms["metrics"].get(k) is not None}
        tw = sum(active.values())
        ms["score"] = round(sum(ms["metrics"][k] * w for k, w in active.items()) / tw, 2) if tw else None

    result["metrics"]["pedal"] = None
    active = {k: w for k, w in WEIGHTS.items() if result["metrics"].get(k) is not None}
    tw = sum(active.values())
    result["overallScore"] = (
        round(sum(result["metrics"][k] * w for k, w in active.items()) / tw, 2) if tw else None
    )
    return result


def run_analyze(data_dir: Path, take_id: str) -> int:
    from ledgerlines_worker import align as align_mod
    from ledgerlines_worker import metrics as metrics_mod
    from ledgerlines_worker import preprocess as preprocess_mod
    from ledgerlines_worker import transcribe as transcribe_mod
    from ledgerlines_worker.issues import generate_issues

    take = read_json(take_path(data_dir, take_id))
    song_id = take["songId"]

    try:
        update_take(data_dir, take_id, status="transcribing", progress=0.1)

        audio_dir = data_dir / "audio" / take_id
        audio_files = list(audio_dir.glob("original.*"))
        if not audio_files:
            raise preprocess_mod.PreprocessError("VALIDATION_FAILED", "audio blob missing")
        src_audio = audio_files[0]

        work_dir = data_dir / "work" / take_id
        pre = preprocess_mod.preprocess(src_audio, work_dir)

        midi_path = data_dir / "derived-takes" / take_id / "transcription.mid"
        transcribe_mod.transcribe(pre["path"], midi_path)

        update_take(data_dir, take_id, status="aligning", progress=0.55)

        reference = read_json(data_dir / "derived" / song_id / "reference.json")
        est_notes = align_mod.load_est(midi_path)
        alignment = align_mod.align(reference, est_notes, mode="jump")
        write_json(data_dir / "derived-takes" / take_id / "alignment.json", alignment)

        update_take(data_dir, take_id, status="scoring", progress=0.8)

        est_notes_full, est_pedal = metrics_mod.load_est(midi_path)
        result = metrics_mod.compute(reference, est_notes_full, alignment, est_pedal, ref_pedal=[])
        result = mask_unavailable_pedal(result)
        issues = generate_issues(result["measureScores"])

        update_take(
            data_dir,
            take_id,
            status="completed",
            progress=1.0,
            overallScore=result["overallScore"],
            metrics=result["metrics"],
            metricsNAReason={"pedal": "参照譜からペダル記号を抽出できていないため測定できません。"},
            measureScores=result["measureScores"],
            issues=issues,
            failure=None,
            aiReview=None,  # S6 (Microsoft Foundry) は未実装。後続フェーズで差し込む。
            analysis={
                "pipelineVersion": "0.1.0-m5",
                "preprocess": {**pre, "path": str(pre["path"])},
                "baseTempo": result["baseTempo"],
                "takes": alignment.get("takes"),
            },
        )
        print(json.dumps({"ok": True, "takeId": take_id, "overallScore": result["overallScore"]}))
        return 0
    except preprocess_mod.PreprocessError as exc:
        update_take(
            data_dir,
            take_id,
            status="failed",
            failure={"code": exc.code, "message": exc.message},
        )
        print(json.dumps({"ok": False, "code": exc.code, "error": exc.message}))
        return 1
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        update_take(
            data_dir,
            take_id,
            status="failed",
            failure={"code": "INTERNAL", "message": str(exc)},
        )
        print(json.dumps({"ok": False, "code": "INTERNAL", "error": str(exc)}))
        return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["reference", "analyze"], required=True)
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--song-id")
    ap.add_argument("--take-id")
    args = ap.parse_args()

    if args.mode == "reference":
        if not args.song_id:
            print("song-id required for reference mode", file=sys.stderr)
            return 2
        return run_reference(args.data_dir, args.song_id)

    if not args.take_id:
        print("take-id required for analyze mode", file=sys.stderr)
        return 2
    return run_analyze(args.data_dir, args.take_id)


if __name__ == "__main__":
    raise SystemExit(main())
