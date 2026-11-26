FROM python:3.12-slim

ARG APP_UID=10001
ARG APP_GID=10001
ARG APP_HOME=/var/cache/viread
ARG APP_PORT=8020

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    VIREAD_OCR_CPU_THREADS=2 \
    HOME=${APP_HOME} \
    PADDLEOCR_HOME=${APP_HOME}/.paddleocr \
    VIREAD_OCR_MODEL_CACHE_DIR=/tmp/viread-models \
    PORT=${APP_PORT} \
    PYTHONPATH=/app:/app/backend

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-vie \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ocr_worker/requirements.txt /app/ocr_worker/requirements.txt

# Pin setuptools<82 (pkg_resources required by paddle), CPU PyTorch wheels,
# --no-deps on vietocr/imgaug/paddleocr/gdown (prevents matplotlib & opencv-python),
# and enforce sole cv2 owner (opencv-python-headless==4.10.0.84).
RUN pip install --no-cache-dir setuptools==77.0.3 \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.14.1 torchvision==0.29.1 \
    && grep -vE '^(setuptools|torch|torchvision|paddleocr|imgaug|vietocr|gdown|prefetch-generator)==' /app/ocr_worker/requirements.txt > /tmp/ocr-base-reqs.txt \
    && pip install --no-cache-dir -r /tmp/ocr-base-reqs.txt \
    && pip install --no-cache-dir --no-deps \
        gdown==4.4.0 \
        prefetch-generator==1.0.1 \
        vietocr==0.3.12 \
        imgaug==0.4.0 \
        paddleocr==2.7.3 \
    && pip uninstall -y opencv-python opencv-contrib-python || true \
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless==4.10.0.84 \
    && rm -f /tmp/ocr-base-reqs.txt \
    && python -c "import setuptools, pkg_resources, cv2, numpy, google.protobuf, pytesseract, torch, paddle, paddleocr, vietocr; assert numpy.__version__ == '1.26.4'; assert google.protobuf.__version__ == '3.20.2'; assert cv2.__version__ == '4.10.0'"

COPY ocr_worker /app/ocr_worker
COPY ai/vietocr_v2/original_artifact.json /app/ai/vietocr_v2/original_artifact.json
COPY backend/app/services/ocr_engine.py /app/backend/app/services/ocr_engine.py
COPY backend/app/services/ocr_adjudication.py /app/backend/app/services/ocr_adjudication.py
COPY backend/app/services/ocr_punctuation.py /app/backend/app/services/ocr_punctuation.py
COPY backend/app/services/ocr_evidence.py /app/backend/app/services/ocr_evidence.py
COPY backend/app/services/ocr_text_utils.py /app/backend/app/services/ocr_text_utils.py
COPY backend/app/services/word_box_geometry.py /app/backend/app/services/word_box_geometry.py
COPY backend/app/services/viread_vietocr_v2_preprocessing.py /app/backend/app/services/viread_vietocr_v2_preprocessing.py

RUN groupadd --gid ${APP_GID} appuser \
    && useradd --uid ${APP_UID} --gid appuser --create-home --home-dir ${APP_HOME} --shell /usr/sbin/nologin appuser \
    && mkdir -p ${APP_HOME}/.paddleocr /tmp/viread-models \
    && chown -R appuser:appuser /app ${APP_HOME} /tmp/viread-models

USER appuser

# Pre-warm PaddleOCR ~16.34 MB det/rec/cls weights into ~/.paddleocr under target UID.
RUN python -c "import torch, paddle; from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='vi', det_algorithm='DB', show_log=False)"

EXPOSE ${APP_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os, urllib.request; p = os.environ.get('PORT', '8020'); urllib.request.urlopen(f'http://127.0.0.1:{p}/health', timeout=3)"

CMD ["sh", "-c", "exec python -m ocr_worker.worker --host 0.0.0.0 --port ${PORT:-8020}"]
