from __future__ import annotations

import logging

from fastapi import FastAPI
from pydantic import BaseModel

from comisionesbi.catalog_engine import catalog as build_catalog
from comisionesbi.comisiones_engine import build_report
from comisionesbi.conciliacion_engine import build_reconciliation

log = logging.getLogger(__name__)

app = FastAPI(title="comisionesbi", version="0.1.0")


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
