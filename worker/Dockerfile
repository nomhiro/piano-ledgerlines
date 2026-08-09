FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_DATA_DIR=/tmp/ledgerlines \
    PIANO_TRANSCRIPTION_CHECKPOINT=/opt/ledgerlines/models/note_F1=0.9677_pedal_F1=0.9186.pth

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 \
    && pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

RUN mkdir -p /opt/ledgerlines/models \
    && curl --fail --location --retry 5 \
      --output "${PIANO_TRANSCRIPTION_CHECKPOINT}" \
      "https://zenodo.org/api/records/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth/content" \
    && echo "22b961b77c1878239fec963362097045  ${PIANO_TRANSCRIPTION_CHECKPOINT}" | md5sum --check -

COPY worker/ledgerlines_worker ./ledgerlines_worker
COPY worker/worker_main.py ./worker_main.py
COPY worker/cloud_worker.py ./cloud_worker.py

ENTRYPOINT ["python", "cloud_worker.py"]
