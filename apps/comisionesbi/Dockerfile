# Dockerfile del servicio comisionesbi (FastAPI: comisiones + conciliación).
#
# Contexto de build: RAÍZ del repo (mismo patrón que proan-hidrocarburos, que a
# su vez lo hereda de Maka) — necesita el pyproject.toml + uv.lock del
# workspace de la raíz para `uv sync --package comisionesbi`.
#
# Build (desde deploy/docker-compose*.yml, context: ..):
#   docker build -f apps/comisionesbi/Dockerfile -t dbc-comisionesbi .
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Resolver dependencias del workspace para el paquete comisionesbi.
COPY pyproject.toml uv.lock ./
COPY apps/comisionesbi/pyproject.toml ./apps/comisionesbi/pyproject.toml

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --package comisionesbi --no-dev

COPY apps/comisionesbi/ ./apps/comisionesbi/

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/apps/comisionesbi

EXPOSE 8091

# Cloud Run inyecta $PORT en el contenedor de entrada; como sidecar (ver
# deploy/cloudrun/service.yaml) se fija PORT=8091 explícitamente. En local
# (docker-compose.dev.yml) también usamos 8091.
CMD ["sh", "-c", "uvicorn comisionesbi.app:app --host 0.0.0.0 --port ${PORT:-8091}"]
