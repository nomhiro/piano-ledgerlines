FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_DATA_DIR=/tmp/ledgerlines

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt ./requirements.txt
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 \
    && pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

COPY worker/ledgerlines_worker ./ledgerlines_worker
COPY worker/worker_main.py ./worker_main.py
COPY worker/cloud_worker.py ./cloud_worker.py

ENTRYPOINT ["python", "cloud_worker.py"]
