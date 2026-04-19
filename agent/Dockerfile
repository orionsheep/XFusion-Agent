FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi httpx psutil "uvicorn[standard]"

COPY agent /app/agent

ENV PYTHONPATH=/app/agent
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9001"]
