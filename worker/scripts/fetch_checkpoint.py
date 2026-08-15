"""ビルド時に採譜モデル（PianoTranscription）のチェックポイントを取得する。

`worker/Dockerfile` の専用 RUN レイヤーから実行される。このレイヤーは
`requirements.txt` のインストールより前に置かれるため、Python標準ライブラリ
だけで完結させる必要がある（torch・piano_transcription_inference等は未インストール）。

背景: `piano_transcription_inference` はチェックポイントが無いと wget での自動取得を
試みるが、本番イメージ（python:3.11-slim）には wget が無いため必ず失敗し、実行時に
「[Errno 2] No such file or directory: .../note_F1=....pth」という分かりにくい
FileNotFoundError になる（docs/poc/m4-report.md 8章、worker/README.md参照）。
wget/curl を apt で追加する代わりに、このスクリプト（urllib のみ）で取得する。
"""

from __future__ import annotations

import hashlib
import pathlib
import sys
import urllib.request

URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)
# 配布ファイル名は `CRNN_note_F1=...` だが、ライブラリ / worker/ledgerlines_worker/
# transcribe.py が既定で探すパスは `note_F1=0.9677_pedal_F1=0.9186.pth`
# （`CRNN_` 接頭辞なし）。保存名をそのまま変えているのはtypoではなく、
# ライブラリ側の既定値に合わせるため（m4-report.md 8章のcurlコマンドと同じ処理）。
DEST = pathlib.Path(
    "/root/piano_transcription_inference_data/note_F1=0.9677_pedal_F1=0.9186.pth"
)
# Zenodoのレスポンスヘッダー(oc-checksum)から取得した、この配布ファイル自体のMD5。
# サイズ下限だけではHTMLのエラー/リダイレクトページがたまたま下限を超える余地を
# 完全には排除できないため、内容そのものを検証する。ZenodoのレコードはDOIで
# 固定され不変のため、このハッシュは安定して使える。
EXPECTED_MD5 = "22b961b77c1878239fec963362097045"
# 実ファイルは約164MiB(171966578 bytes)。HTMLのエラー/リダイレクトページは通常
# 数KB程度なので、余裕を持った下限でも十分に見分けられる。
MIN_SIZE_BYTES = 150 * 1024 * 1024


def main() -> int:
    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading checkpoint from {URL}")
    urllib.request.urlretrieve(URL, DEST)

    size = DEST.stat().st_size
    print(f"downloaded {size} bytes")
    if size < MIN_SIZE_BYTES:
        print(
            f"checkpoint download too small ({size} bytes) - "
            "likely an HTML error/redirect page, not the model file",
            file=sys.stderr,
        )
        return 1

    digest = hashlib.md5(DEST.read_bytes()).hexdigest()
    if digest != EXPECTED_MD5:
        print(
            f"checkpoint MD5 mismatch: expected {EXPECTED_MD5}, got {digest}",
            file=sys.stderr,
        )
        return 1

    print("checkpoint MD5 verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
