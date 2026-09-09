from __future__ import annotations

import logging
import os
from datetime import date

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, model_validator

from comisionesbi.catalog_engine import catalog as build_catalog
from comisionesbi.comisiones_engine import build_report
from comisionesbi.conciliacion_engine import build_conciliacion, detalle_diario, detalle_factura
from comisionesbi.db import BigQueryConfigError, BigQueryQueryError
from comisionesbi.flujo_engine import build_flujo

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
    """Fechas, no cadenas: la tabla gold de comisión es diaria.

    Era `start_period: str` de cuando el módulo devolvía 501 y nadie validaba
    nada. Ahora Pydantic rechaza con 422 lo que no sea una fecha ISO, y aquí
    solo queda comprobar que el rango tiene sentido — igual que en FlujoQuery.
    """

    division: str | None = None
    cedis: str | None = None
    comisionista: str | None = None
    # DBC o PAN. Huevo se factura por las dos y la comisión de PAN es la mayor
    # parte del total, así que hay que poder mirarlas por separado.
    sociedad: str | None = None
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _rango_coherente(self) -> "ReportQuery":
        if self.start_date > self.end_date:
            raise ValueError("start_date no puede ser posterior a end_date.")
        return self


class ReconciliationQuery(BaseModel):
    """Fechas de verdad: la tabla gold de conciliación es por periodo de pago
    (normalmente sáb-vie, pero no siempre — ver v1_conciliacion_producto_semanal.sql)."""

    # DBC o PAN. Solo lo usan /diario y /factura (detalle de UN comisionista ya
    # elegido en pantalla) -- la misma persona puede tener datos en las dos
    # sociedades, y sin este filtro se mezclan en una sola hoja del Excel.
    sociedad: str | None = None
    division: str | None = None
    comisionista: str | None = None
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _rango_coherente(self) -> "ReconciliationQuery":
        if self.start_date > self.end_date:
            raise ValueError("start_date no puede ser posterior a end_date.")
        return self


class FlujoQuery(BaseModel):
    """Fechas de verdad, no cadenas: la tabla gold es diaria.

    Pydantic ya rechaza con 422 lo que no sea una fecha ISO, así que aquí solo
    queda comprobar que el rango tiene sentido.
    """

    division: str | None = None
    cedis: str | None = None
    tipo_venta: str | None = None
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _rango_coherente(self) -> "FlujoQuery":
        if self.start_date > self.end_date:
            raise ValueError("start_date no puede ser posterior a end_date.")
        return self


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/comisionesbi/catalog")
def get_catalog() -> dict:
    """Catálogo de división/CEDIS/tipo de venta (ya resuelto y validado)."""
    return build_catalog()


@app.post("/v1/comisionesbi/flujo")
def post_flujo(body: FlujoQuery) -> dict:
    """Flujo de producto: vendido, facturado y cobrado — ver flujo_engine.py.

    Devuelve también `cobertura`, la fecha de corte de cada fase. Hoy no
    coinciden y eso no es un detalle menor: sin ese dato la pantalla dibujaría
    ceros donde solo faltan datos.
    """
    return build_flujo(
        division=body.division,
        cedis=body.cedis,
        tipo_venta=body.tipo_venta,
        start_date=body.start_date,
        end_date=body.end_date,
    )


@app.post("/v1/comisionesbi/report")
def post_report(body: ReportQuery) -> dict:
    """Módulo de comisión — ver comisiones_engine.py.

    Devuelve lo devengado Y lo que está bloqueado, siempre juntos: todavía no
    se calcula sobre todo el facturado, así que el total sin su contexto sería
    un número que nadie puede cuadrar.
    """
    return build_report(
        division=body.division,
        cedis=body.cedis,
        comisionista=body.comisionista,
        sociedad=body.sociedad,
        start_date=body.start_date,
        end_date=body.end_date,
    )


@app.post("/v1/comisionesbi/reconciliation")
def post_reconciliation(body: ReconciliationQuery) -> dict:
    """Conciliación por comisionista, detalle por producto — ver conciliacion_engine.py."""
    return build_conciliacion(
        division=body.division,
        comisionista=body.comisionista,
        start_date=body.start_date,
        end_date=body.end_date,
    )


@app.post("/v1/comisionesbi/reconciliation/diario")
def post_reconciliation_diario(body: ReconciliationQuery) -> list[dict]:
    """Detalle día por día, para la pestaña de transparencia del Excel exportado.

    Mismo filtro que /reconciliation, pero sin agregar por periodo de pago —
    ver conciliacion_engine.detalle_diario.
    """
    return detalle_diario(
        sociedad=body.sociedad,
        division=body.division,
        comisionista=body.comisionista,
        start_date=body.start_date,
        end_date=body.end_date,
    )


@app.post("/v1/comisionesbi/reconciliation/factura")
def post_reconciliation_factura(body: ReconciliationQuery) -> list[dict]:
    """Detalle a nivel línea de factura real, con cobro — la hoja de máximo
    detalle del Excel exportado. Ver conciliacion_engine.detalle_factura.
    """
    return detalle_factura(
        sociedad=body.sociedad,
        division=body.division,
        comisionista=body.comisionista,
        start_date=body.start_date,
        end_date=body.end_date,
    )
