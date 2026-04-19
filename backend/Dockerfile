FROM python:3.12-slim

WORKDIR /app

COPY backend/pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir \
  aiosqlite asyncssh claude-agent-sdk fastapi httpx orjson \
  "passlib[bcrypt]" psutil pydantic-settings "python-jose[cryptography]" \
  python-multipart sqlmodel "uvicorn[standard]"

COPY backend /app/backend

ENV PYTHONPATH=/app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
