FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    VIREAD_OCR_CPU_THREADS=2 \
    HOME=/var/cache/viread \
    PADDLEOCR_HOME=/var/cache/viread/.paddleocr \
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

# Pin PyTorch CPU wheels, install paddleocr --no-deps, and enforce sole cv2 owner (opencv-python-headless==4.10.0.84).
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.14.1 torchvision==0.29.1 \
    && grep -vE '^(torch|torchvision|paddleocr|imgaug)==' /app/ocr_worker/requirements.txt > /tmp/ocr-base-reqs.txt \
    && pip install --no-cache-dir -r /tmp/ocr-base-reqs.txt \
    && pip install --no-cache-dir --no-deps imgaug==0.4.0 paddleocr==2.7.3 \
    && pip uninstall -y opencv-python opencv-contrib-python || true \
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless==4.10.0.84 \
    && rm -f /tmp/ocr-base-reqs.txt \
    && python -c "import cv2, numpy, google.protobuf, pytesseract; assert numpy.__version__ == '1.26.4'; assert google.protobuf.__version__ == '3.20.2'; assert cv2.__version__ == '4.10.0'"

COPY ocr_worker /app/ocr_worker
COPY ai/vietocr_v2/original_artifact.json /app/ai/vietocr_v2/original_artifact.json
COPY backend/app/services/ocr_engine.py /app/backend/app/services/ocr_engine.py
COPY backend/app/services/ocr_adjudication.py /app/backend/app/services/ocr_adjudication.py
COPY backend/app/services/ocr_punctuation.py /app/backend/app/services/ocr_punctuation.py
COPY backend/app/services/ocr_evidence.py /app/backend/app/services/ocr_evidence.py
COPY backend/app/services/ocr_text_utils.py /app/backend/app/services/ocr_text_utils.py
COPY backend/app/services/word_box_geometry.py /app/backend/app/services/word_box_geometry.py
COPY backend/app/services/viread_vietocr_v2_preprocessing.py /app/backend/app/services/viread_vietocr_v2_preprocessing.py

RUN groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid appuser --home-dir /var/cache/viread --shell /usr/sbin/nologin appuser \
    && mkdir -p /var/cache/viread/.paddleocr \
    && chown -R appuser:appuser /app /var/cache/viread

USER appuser

EXPOSE 8020

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8020/health', timeout=3)"

CMD ["python", "-m", "ocr_worker.worker", "--host", "0.0.0.0", "--port", "8020"]
