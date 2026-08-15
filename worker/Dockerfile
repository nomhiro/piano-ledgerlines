# syntax=docker/dockerfile:1.4
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_DATA_DIR=/tmp/ledgerlines

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# 採譜モデル（PianoTranscription）のチェックポイントをイメージに同梱する。
# piano_transcription_inference はチェックポイントが無いと wget で自動取得しようと
# するが、python:3.11-slim には wget が無いため必ず失敗し、実行時に
# 「[Errno 2] No such file or directory: .../note_F1=....pth」という分かりにくい
# FileNotFoundError になる（docs/poc/m4-report.md 8章、worker/README.md参照）。
# wget/curl を apt で追加する代わりに標準ライブラリ(urllib)だけで取得する。
#
# 依存するのはOSパッケージだけで、requirements.txt / アプリコードには依存しない
# ため、それらより前の独立レイヤーに置く。こうしておけば通常のコード変更や
# requirements.txt の更新のたびに170MBのモデルを再ダウンロードすることはない。
#
# 配布ファイル名は `CRNN_note_F1=...` だが、ライブラリ / worker/ledgerlines_worker/
# transcribe.py が既定で探すパスは `note_F1=0.9677_pedal_F1=0.9186.pth`
# （`CRNN_` 接頭辞なし）。保存名をそのまま変えているのはtypoではなく、
# ライブラリ側の既定値に合わせるため（m4-report.md 8章のcurlコマンドと同じ処理）。
RUN python - <<'PY'
import hashlib
import pathlib
import sys
import urllib.request

URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)
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

DEST.parent.mkdir(parents=True, exist_ok=True)
print(f"downloading checkpoint from {URL}")
urllib.request.urlretrieve(URL, DEST)

size = DEST.stat().st_size
print(f"downloaded {size} bytes")
if size < MIN_SIZE_BYTES:
    sys.exit(
        f"checkpoint download too small ({size} bytes) - "
        "likely an HTML error/redirect page, not the model file"
    )

digest = hashlib.md5(DEST.read_bytes()).hexdigest()
if digest != EXPECTED_MD5:
    sys.exit(f"checkpoint MD5 mismatch: expected {EXPECTED_MD5}, got {digest}")

print("checkpoint MD5 verified")
PY

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 \
    && pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

COPY worker/ledgerlines_worker ./ledgerlines_worker
COPY worker/worker_main.py ./worker_main.py
COPY worker/cloud_worker.py ./cloud_worker.py

ENTRYPOINT ["python", "cloud_worker.py"]
