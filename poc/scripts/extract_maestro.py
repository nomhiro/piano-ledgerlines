"""MAESTRO の TFRecord シャードから音声と ID を取り出す。

標準ライブラリのみで動く。TFRecord のレコード枠と tf.train.Example の
protobuf wire format を直接読む（tensorflow への依存を避けるため）。

TFRecord のレコード形式:
    uint64 length (LE) / uint32 crc(length) / bytes data[length] / uint32 crc(data)

tf.train.Example:
    Example  { Features features = 1 }
    Features { map<string, Feature> feature = 1 }
    Feature  { BytesList bytes_list = 1 | FloatList = 2 | Int64List = 3 }
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

WIRE_VARINT, WIRE_64BIT, WIRE_LEN, WIRE_32BIT = 0, 1, 2, 5


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def iter_fields(buf: bytes, start: int = 0, end: int | None = None):
    """(field_number, wire_type, payload) を順に返す。"""
    end = len(buf) if end is None else end
    pos = start
    while pos < end:
        key, pos = read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == WIRE_VARINT:
            val, pos = read_varint(buf, pos)
            yield field, wire, val
        elif wire == WIRE_LEN:
            size, pos = read_varint(buf, pos)
            yield field, wire, buf[pos : pos + size]
            pos += size
        elif wire == WIRE_64BIT:
            yield field, wire, buf[pos : pos + 8]
            pos += 8
        elif wire == WIRE_32BIT:
            yield field, wire, buf[pos : pos + 4]
            pos += 4
        else:
            raise ValueError(f"unsupported wire type {wire} at {pos}")


def parse_example(data: bytes) -> dict[str, list]:
    """tf.train.Example を {key: [values]} に展開する。"""
    out: dict[str, list] = {}
    for field, _, payload in iter_fields(data):
        if field != 1:  # Example.features
            continue
        for f2, _, features_payload in iter_fields(payload):
            if f2 != 1:  # Features.feature (map entry)
                continue
            key = None
            values: list = []
            for f3, _, entry in iter_fields(features_payload):
                if f3 == 1:  # map key
                    key = entry.decode("utf-8")
                elif f3 == 2:  # map value = Feature
                    for kind, _, lst in iter_fields(entry):
                        for _, w, v in iter_fields(lst):
                            if kind == 2 and w == WIRE_32BIT:  # float_list
                                values.append(struct.unpack("<f", v)[0])
                            else:  # bytes_list / int64_list
                                values.append(v)
            if key is not None:
                out[key] = values
    return out


def iter_records(path: Path):
    """TFRecord を先頭から読む。末尾が途中で切れていたら静かに終了する。"""
    with path.open("rb") as fh:
        while True:
            header = fh.read(12)
            if len(header) < 12:
                return
            (length,) = struct.unpack("<Q", header[:8])
            payload = fh.read(length)
            if len(payload) < length:
                return  # Range 取得で切れている
            if len(fh.read(4)) < 4:
                return
            yield payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("shard", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=3)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []

    for i, record in enumerate(iter_records(args.shard)):
        if len(manifest) >= args.limit:
            break
        try:
            ex = parse_example(record)
        except (IndexError, ValueError) as exc:
            print(f"record {i}: parse failed ({exc})", file=sys.stderr)
            continue

        audio = ex.get("audio", [b""])[0]
        raw_id = ex.get("id", [b""])[0]
        take_id = raw_id.decode("utf-8", "replace") if isinstance(raw_id, bytes) else str(raw_id)

        if not audio:
            print(f"record {i}: keys={sorted(ex)} (no audio)", file=sys.stderr)
            continue

        name = f"maestro_{i:02d}"
        wav_path = args.out / f"{name}.wav"
        wav_path.write_bytes(audio)

        seq = ex.get("sequence", [b""])[0]
        if seq:
            (args.out / f"{name}.notesequence.pb").write_bytes(seq)

        manifest.append(
            {
                "name": name,
                "id": take_id,
                "wav": wav_path.name,
                "bytes": len(audio),
                "has_sequence": bool(seq),
            }
        )
        print(f"record {i}: id={take_id!r} audio={len(audio) / 1e6:.1f}MB keys={sorted(ex)}")

    (args.out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nwrote {len(manifest)} file(s) to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
