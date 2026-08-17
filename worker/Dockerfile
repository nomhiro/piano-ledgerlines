FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_DATA_DIR=/tmp/ledgerlines

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# PDF の OMR（Audiveris）。デプロイ環境でも PDF を MusicXML 化するために同梱する
# （Issue #45）。Audiveris の Linux 配布物（.deb）は jpackage 製で自前の JRE と
# Tesseract（JNI経由）を同梱しているため、JDKやtesseract-ocrを別途 apt で入れる
# 必要はない。ただしその同梱JVM/ネイティブライブラリが依存する共有ライブラリ
# （.deb の Depends、AWT/X11関連含む）は無いとリンクエラーで起動できないため、
# こちらは apt で入れる（詳細は worker/scripts/fetch_audiveris.py 参照）。
#
# ライセンス: Audiveris は AGPL-3.0。バージョン・入手元・ライセンス本文の
# 置き場所は worker/README.md に記録している。
ARG AUDIVERIS_VERSION=5.10.2
ENV AUDIVERIS_HOME=/opt/audiveris \
    AUDIVERIS_COMMAND=/opt/audiveris/bin/Audiveris
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libasound2 libbsd0 libc6 libmd0 libx11-6 libxau6 libxcb1 libxdmcp6 \
        libxext6 libxi6 libxrender1 libxtst6 xdg-utils zlib1g \
    && rm -rf /var/lib/apt/lists/*
# fetch_audiveris.py は fetch_checkpoint.py の fetch_with_retry を import して
# 再利用する（重複実装を避けるため）。fetch_checkpoint.py 用の独立レイヤーは
# この後ろにあるため、import できるようここでも同じ /tmp に置く。
COPY worker/scripts/fetch_checkpoint.py /tmp/fetch_checkpoint.py
COPY worker/scripts/fetch_audiveris.py /tmp/fetch_audiveris.py
RUN python /tmp/fetch_audiveris.py && rm /tmp/fetch_audiveris.py /tmp/fetch_checkpoint.py

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
