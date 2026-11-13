FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY service.py main.py ./

ENV PORT=8080
CMD ["sh", "-c", "exec functions-framework --target=handler --source=main.py --host=0.0.0.0 --port=${PORT}"]
