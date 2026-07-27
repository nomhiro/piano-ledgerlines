"""実 MusicXML を参照譜として使った場合の挙動を検証する（M5 持ち越し課題2）。

制約: 本 PoC のデータセット（MAESTRO の90秒抜粋 4曲）には対応する公式 MusicXML が
存在しない（MAESTRO は演奏 MIDI ベースのデータセットで、抜粋区間に対応する
市販・公開楽譜の版が特定できないため）。したがって「実演奏との突き合わせ」は
このデータセットでは行えない。

そこで本検証は次の2点に限定する。
  1. make_reference.py が前提にしている reference.json のスキーマ
     （index / pitch / startBeat / measure / beatInMeasure / durationBeats）が、
     実際の MusicXML（music21 corpus の公開楽譜）からも構築できるかの形式検証。
  2. MIDI 量子化にはない、MusicXML 特有の処理課題を洗い出す。
     具体的には「タイで結ばれた音符」「アウフタクト（不完全小節）」の扱い。
     タイは MIDI では単なる1つの長い音として現れるが、
     MusicXML ではタイで結ばれた別々の音符として記譜されているため、
     結合しないと同じ1音がアライメント上「2つの短い音符」に化けてしまう。

参照譜が作れたら、その音符列に小さなタイミング揺らぎを加えた「演奏もどき」を作り、
align.py にそのまま通して構造的に破綻しないかを確認する
（実演奏データがないための代替チェックであり、実録音での検証ではない）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

TICKS_PER_BEAT = 1.0  # music21 の quarterLength をそのまま拍として使う


def load_score(source: str):
    from music21 import converter, corpus

    if source.endswith((".xml", ".musicxml", ".mxl")):
        return converter.parse(source)
    return corpus.parse(source)


def merge_ties(part) -> list:
    """タイで結ばれた音符を1つの音符（開始拍・合計長）に統合する。"""
    merged = []
    pending: dict[int, dict] = {}
    for n in part.flatten().notes:
        pitches = n.pitches if n.isChord else [n.pitch]
        for p in pitches:
            key = p.midi
            tie = n.tie.type if n.tie else None
            if tie in ("stop", "continue") and key in pending:
                pending[key]["durationBeats"] += float(n.duration.quarterLength)
                if tie == "stop":
                    merged.append(pending.pop(key))
            else:
                rec = {
                    "pitch": key,
                    "startBeat": float(n.offset),
                    "durationBeats": float(n.duration.quarterLength),
                    "measure": n.measureNumber,
                }
                if tie in ("start", "continue"):
                    pending[key] = rec
                else:
                    merged.append(rec)
    # タイが閉じずに終わった分も回収する
    merged.extend(pending.values())
    return merged


def build_reference(source: str, tempo_bpm: float = 96.0) -> dict:
    score = load_score(source)
    ts_list = score.parts[0].recurse().getElementsByClass("TimeSignature")
    beats_per_measure = float(ts_list[0].numerator) if ts_list else 4.0

    notes = []
    for part in score.parts:
        notes.extend(merge_ties(part))
    notes.sort(key=lambda n: (n["startBeat"], n["pitch"]))

    measure_start_beat: dict[int, float] = {}
    for n in notes:
        m = n["measure"]
        measure_start_beat.setdefault(m, n["startBeat"])
        measure_start_beat[m] = min(measure_start_beat[m], n["startBeat"])

    out_notes = []
    for i, n in enumerate(notes):
        beat_in_measure = n["startBeat"] - measure_start_beat[n["measure"]]
        out_notes.append(
            {
                "index": i,
                "pitch": n["pitch"],
                "startBeat": round(n["startBeat"], 4),
                "durationBeats": round(n["durationBeats"], 4),
                "measure": n["measure"],
                "beatInMeasure": round(beat_in_measure, 4),
                "dynamicLevel": 2,
                # 実演奏データがないため gtStart/gtIndex は持たない
                # （MIDI 量子化版の reference.json との差分）
            }
        )

    return {
        "name": source,
        "estimatedTempo": tempo_bpm,
        "beatsPerMeasure": beats_per_measure,
        "measureCount": max((n["measure"] for n in notes), default=0),
        "notes": out_notes,
        "source": "musicxml",
    }


def fake_performance(reference: dict, tempo_bpm: float, jitter: float, rng) -> list[dict]:
    """MusicXML 由来の参照譜に軽い揺らぎを加えた「演奏もどき」。

    実録音がないための構造検証専用。align.py の cost_matrix/DTW が
    MusicXML 由来のスキーマ（タイ結合済み・アウフタクト含む）でも
    正しく動くかどうかを見るためだけに使う。
    """
    sec_per_beat = 60.0 / tempo_bpm
    est = []
    for i, n in enumerate(reference["notes"]):
        d = float(rng.normal(0.0, jitter))
        start = max(0.0, n["startBeat"] * sec_per_beat + d)
        dur = max(0.05, n["durationBeats"] * sec_per_beat)
        est.append({"index": i, "pitch": n["pitch"], "start": start, "end": start + dur})
    est.sort(key=lambda n: (n["start"], n["pitch"]))
    for i, n in enumerate(est):
        n["index"] = i
    return est


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="bach/bwv66.6", help="music21 corpus 名 or .musicxml パス")
    ap.add_argument("--tempo", type=float, default=96.0)
    ap.add_argument("--jitter", type=float, default=0.02)
    ap.add_argument("--out", type=Path, default=Path("out/musicxml_reference.json"))
    args = ap.parse_args()

    reference = build_reference(args.source, args.tempo)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(reference, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"reference notes: {len(reference['notes'])}  measures: {reference['measureCount']}")

    rng = np.random.default_rng(20261001)
    est = fake_performance(reference, args.tempo, args.jitter, rng)

    from align import align

    result = align(reference, est, mode="jump")
    n_ref = len(reference["notes"])
    print(
        f"align smoke test: pairs={len(result['pairs'])}/{n_ref} "
        f"missed={len(result['missed'])} extra={len(result['extra'])} takes={result.get('takes')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
