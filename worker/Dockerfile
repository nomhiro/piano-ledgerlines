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
# wget/curl を apt で追加する代わりに標準ライブラリ(urllib)だけで取得する
# （worker/scripts/fetch_checkpoint.py、詳細・サイズ下限・MD5検証の理由はそこに記載）。
#
# 依存するのはOSパッケージだけで、requirements.txt / アプリコードには依存しない
# ため、それらより前の独立レイヤーに置く。こうしておけば通常のコード変更や
# requirements.txt の更新のたびに170MBのモデルを再ダウンロードすることはない
# （このレイヤーが無効化されるのは fetch_checkpoint.py 自体を変更した時だけ）。
COPY worker/scripts/fetch_checkpoint.py /tmp/fetch_checkpoint.py
RUN python /tmp/fetch_checkpoint.py && rm /tmp/fetch_checkpoint.py

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 \
    && pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

COPY worker/ledgerlines_worker ./ledgerlines_worker
COPY worker/worker_main.py ./worker_main.py
COPY worker/cloud_worker.py ./cloud_worker.py

ENTRYPOINT ["python", "cloud_worker.py"]
