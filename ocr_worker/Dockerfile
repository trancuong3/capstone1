FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    VIREAD_OCR_CPU_THREADS=2 \
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
RUN pip install --no-cache-dir -r /app/ocr_worker/requirements.txt

COPY ocr_worker /app/ocr_worker
COPY backend/app/services/ocr_engine.py /app/backend/app/services/ocr_engine.py
COPY backend/app/services/ocr_adjudication.py /app/backend/app/services/ocr_adjudication.py
COPY backend/app/services/ocr_punctuation.py /app/backend/app/services/ocr_punctuation.py
COPY backend/app/services/ocr_evidence.py /app/backend/app/services/ocr_evidence.py
COPY backend/app/services/word_box_geometry.py /app/backend/app/services/word_box_geometry.py
COPY backend/app/services/viread_vietocr_v2_preprocessing.py /app/backend/app/services/viread_vietocr_v2_preprocessing.py

EXPOSE 8020

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8020/health', timeout=3)"

CMD ["python", "-m", "ocr_worker.worker", "--host", "0.0.0.0", "--port", "8020"]
