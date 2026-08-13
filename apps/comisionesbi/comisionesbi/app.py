from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from comisionesbi.catalog_engine import catalog as build_catalog
from comisionesbi.comisiones_engine import build_report
from comisionesbi.conciliacion_engine import build_reconciliation
from comisionesbi.db import BigQueryConfigError, BigQueryQueryError

# uvicorn configura sus propios loggers, no el raíz: sin esto los mensajes de
# los motores se perderían por debajo de WARNING. En Cloud Run todo lo que sale
# por stderr acaba en Cloud Logging.
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

log = logging.getLogger(__name__)

app = FastAPI(title="comisionesbi", version="0.1.0")


# ─── Fallos de BigQuery → 503 ────────────────────────────────────────────
# 503 y no 500: es una dependencia no disponible, no un error de programación.
# El frontend ya traduce el 5xx a "vuelve a intentarlo en unos instantes"
# (apps/frontend/src/lib/comisionesbi.ts).


@app.exception_handler(BigQueryQueryError)
def handle_bigquery_query_error(request: Request, exc: BigQueryQueryError) -> JSONResponse:
    # La traza completa ya se registró en el motor; aquí se añade el endpoint.
    log.error("503 en %s — %s", request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(BigQueryConfigError)
def handle_bigquery_config_error(request: Request, exc: BigQueryConfigError) -> JSONResponse:
    # Fallo de despliegue, y su mensaje nombra variables de entorno: al log el
    # motivo exacto, al cliente solo que el servicio no está disponible.
    log.critical("Configuración de BigQuery inválida (%s): %s", request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "El servicio no está disponible: falta configuración de BigQuery."},
    )


class ReportQuery(BaseModel):
    division: str | None = None
    cedis: str | None = None
    start_period: str
    end_period: str


class ReconciliationQuery(BaseModel):
    provider_id: str | None = None
    start_period: str
    end_period: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/comisionesbi/catalog")
def get_catalog() -> dict:
    """Catálogo de división/CEDIS/tipo de venta (ya resuelto y validado)."""
    return build_catalog()


@app.post("/v1/comisionesbi/report")
def post_report(body: ReportQuery) -> dict:
    """Módulo de comisión y compensación — ver comisiones_engine.py (bloqueado)."""
    return build_report(
        division=body.division,
        cedis=body.cedis,
        start_period=body.start_period,
        end_period=body.end_period,
    )


@app.post("/v1/comisionesbi/reconciliation")
def post_reconciliation(body: ReconciliationQuery) -> dict:
    """Módulo de conciliación documental — ver conciliacion_engine.py (bloqueado)."""
    return build_reconciliation(
        provider_id=body.provider_id,
        start_period=body.start_period,
        end_period=body.end_period,
    )
