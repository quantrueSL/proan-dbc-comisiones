from __future__ import annotations

import logging
import os
from datetime import date

from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from comisionesbi.catalog_engine import catalog as build_catalog
from comisionesbi.comisiones_engine import build_report
from comisionesbi import conciliacion_cortes_service as cortes
from comisionesbi.conciliacion_cortes_engine import ErrorCorte
from comisionesbi.conciliacion_cortes_estado import ConflictoVersion, FirestoreError
from comisionesbi.conciliacion_cortes_service import build_detalle, build_fila, build_mes
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
    comisionista_id: str | None = None
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
    comisionista_id: str | None = None
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _rango_coherente(self) -> "ReconciliationQuery":
        if self.start_date > self.end_date:
            raise ValueError("start_date no puede ser posterior a end_date.")
        return self


# ─── Errores de la conciliación por cortes ───────────────────────────────


@app.exception_handler(ErrorCorte)
def handle_error_corte(request: Request, exc: ErrorCorte) -> JSONResponse:
    # Un corte congelado es un conflicto con lo ya cerrado; el resto, una petición que no se puede cumplir.
    estado = 409 if exc.codigo == "corte_congelado" else 422
    return JSONResponse(status_code=estado, content={"detail": str(exc), "codigo": exc.codigo})


@app.exception_handler(ConflictoVersion)
def handle_conflicto_version(request: Request, exc: ConflictoVersion) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc), "codigo": exc.codigo})


@app.exception_handler(FirestoreError)
def handle_firestore_error(request: Request, exc: FirestoreError) -> JSONResponse:
    log.error("503 en %s — %s", request.url.path, exc)
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def editor(x_usuario: str | None = Header(default=None), x_rol: str | None = Header(default=None)) -> str:
    """Quién edita. El sidecar no tiene URL pública: el frontend ya validó la sesión y reenvía usuario y rol."""
    if x_rol != "admin":
        raise HTTPException(status_code=403, detail="No tienes permiso para editar cortes.")
    return (x_usuario or "").strip() or "desconocido"


class CortesMesQuery(BaseModel):
    """Mes en formato AAAA-MM; los demás filtros son opcionales (la pantalla filtra también en el cliente)."""

    mes: str | None = Field(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    # Alternativa al mes: las semanas que se ven en pantalla (la pantalla las desplaza de una en una).
    desde: date | None = None
    hasta: date | None = None
    sociedad: str | None = None
    division: str | None = None
    comisionista_id: str | None = None

    @model_validator(mode="after")
    def _periodo(self) -> "CortesMesQuery":
        if self.desde and self.hasta:
            if self.desde > self.hasta:
                raise ValueError("desde no puede ser posterior a hasta.")
            # el mes con 2 semanas de contexto a cada lado llega a 70 días
            if (self.hasta - self.desde).days > 84:
                raise ValueError("El rango no puede pasar de 84 días.")
        elif not self.mes:
            raise ValueError("Indica el mes (AAAA-MM) o el rango desde/hasta.")
        return self


class CortesFilaQuery(BaseModel):
    mes: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    sociedad: str
    comisionista_id: str
    # Los pagos cuyo texto no trae división reconocible quedan en una fila sin división.
    division_code: str | None = None


class CortesEdicion(CortesFilaQuery):
    """Toda edición dice qué versión de la fila vio la persona (control de concurrencia)."""

    version: int


class CortesMoverBody(CortesEdicion):
    izq_pago_id: str
    # Último día del pago de la izquierda (el corte).
    fecha: date


class CortesMoverBordeBody(CortesEdicion):
    pago_id: str
    borde: Literal["ini", "fin"]
    fecha: date


class CortesCambioBody(BaseModel):
    pago_id: str
    borde: Literal["ini", "fin"]
    de: date
    a: date


class CortesAplicarBody(CortesEdicion):
    pago_id: str
    # Los cambios que la persona vio; si la sugerencia ya es otra, se rechaza.
    cambios: list[CortesCambioBody] | None = None
    # Los días de cierre que la persona vio en una sugerencia de ese tipo.
    dias: list[date] | None = None
    # Las semanas de 4 SKUs que la persona vio en una sugerencia de ese tipo.
    bloques: list[date] | None = None


class CortesPagoBody(CortesEdicion):
    pago_id: str


class CortesComentarBody(CortesEdicion):
    pago_id: str
    texto: str = Field(max_length=1000)


class CortesBorrarComentarioBody(CortesEdicion):
    pago_id: str
    comentario_id: str


class CortesReabrirBody(CortesEdicion):
    pago_ids: list[str] = Field(min_length=1, max_length=20)


class CortesLoteBody(BaseModel):
    """Consolida lo que cuadra en las filas dadas (`sociedad|comisionista_id|división`); el plan lo arma el servidor."""

    mes: str | None = Field(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    desde: date | None = None
    hasta: date | None = None
    fila_ids: list[str] = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def _periodo(self) -> "CortesLoteBody":
        if not ((self.desde and self.hasta) or self.mes):
            raise ValueError("Indica el mes (AAAA-MM) o el rango desde/hasta.")
        return self


class CortesSemanaSkus(BaseModel):
    ini: date
    fin: date


class CortesLineasBody(BaseModel):
    sociedad: str
    comisionista_id: str
    division_code: str | None = None
    docs: list[str] = Field(max_length=4)
    ini: date
    fin: date
    dias: list[date] = Field(default_factory=list, max_length=31)
    skus: list[CortesSemanaSkus] = Field(default_factory=list, max_length=40)


class CortesExportarBody(BaseModel):
    sociedad: str
    comisionista_id: str
    division_code: str | None = None
    ini: date
    fin: date
    # Días de cierre de mes que el pago tiene asignados (se suman a su ventana).
    dias: list[date] = Field(default_factory=list, max_length=31)
    # Semanas de los 4 SKUs de Botana que el pago incluye (de la suya o de otra): primer y último día de cada una.
    skus: list[CortesSemanaSkus] = Field(default_factory=list, max_length=40)


class CortesVentanaBody(CortesEdicion):
    pago_id: str
    ini: date
    fin: date


class CortesDiasBody(CortesEdicion):
    pago_id: str
    dias: list[date] = Field(max_length=31)


class CortesSkusBody(CortesEdicion):
    bloques_ini: list[date] = Field(min_length=1, max_length=40)
    # Pago al que se mueve esa semana de 4 SKUs; vacío = vuelve a quedar sin pagar.
    pago_id: str | None = None


class CortesAnioBody(BaseModel):
    anio: int = Field(ge=2020, le=2100)


class CortesHistorialBody(BaseModel):
    sociedad: str
    comisionista_id: str
    division_code: str | None = None
    limite: int = Field(default=30, ge=1, le=200)


class CortesDetalleQuery(BaseModel):
    sociedad: str
    comisionista_id: str
    division_code: str | None = None
    ini: date
    fin: date

    @model_validator(mode="after")
    def _rango_coherente(self) -> "CortesDetalleQuery":
        if self.ini > self.fin:
            raise ValueError("ini no puede ser posterior a fin.")
        return self


class FlujoQuery(BaseModel):
    """Fechas de verdad, no cadenas: la tabla gold es diaria.

    Pydantic ya rechaza con 422 lo que no sea una fecha ISO, así que aquí solo
    queda comprobar que el rango tiene sentido.
    """

    division: str | None = None
    cedis: str | None = None
    tipo_venta: str | None = None
    # DBC o PAN (2026-09-10) -- ver flujo_engine.py, mismo criterio que
    # ReportQuery.sociedad de arriba.
    sociedad: str | None = None
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
        sociedad=body.sociedad,
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
        comisionista_id=body.comisionista_id,
        sociedad=body.sociedad,
        start_date=body.start_date,
        end_date=body.end_date,
    )


@app.post("/v1/comisionesbi/reconciliation")
def post_reconciliation(body: ReconciliationQuery) -> dict:
    """Conciliación por comisionista, detalle por producto — ver conciliacion_engine.py."""
    return build_conciliacion(
        division=body.division,
        comisionista_id=body.comisionista_id,
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
        comisionista_id=body.comisionista_id,
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
        comisionista_id=body.comisionista_id,
        start_date=body.start_date,
        end_date=body.end_date,
    )


# ─── Conciliación por cortes (pestaña nueva, ver conciliacion_cortes_service.py) ───


@app.post("/v1/comisionesbi/cortes/mes")
def post_cortes_mes(body: CortesMesQuery) -> dict:
    """La lista del mes: pagos por sociedad × comisionista × división con su estado y sugerencia."""
    return build_mes(
        mes=body.mes,
        desde=body.desde,
        hasta=body.hasta,
        sociedad=body.sociedad,
        division=body.division,
        comisionista_id=body.comisionista_id,
    )


@app.post("/v1/comisionesbi/cortes/fila")
def post_cortes_fila(body: CortesFilaQuery) -> dict:
    """El panel de una fila: todos sus pagos cercanos al mes y sus cobros diarios."""
    return build_fila(
        mes=body.mes,
        sociedad=body.sociedad,
        comisionista_id=body.comisionista_id,
        division_code=body.division_code,
    )


@app.post("/v1/comisionesbi/cortes/detalle")
def post_cortes_detalle(body: CortesDetalleQuery) -> dict:
    """Detalle por producto acotado a la ventana de un pago."""
    return build_detalle(
        sociedad=body.sociedad,
        comisionista_id=body.comisionista_id,
        division_code=body.division_code,
        ini=body.ini,
        fin=body.fin,
    )


def _llave(body) -> tuple:
    return (body.sociedad, body.comisionista_id, body.division_code)


@app.post("/v1/comisionesbi/cortes/mover")
def post_cortes_mover(body: CortesMoverBody, usuario: str = Depends(editor)) -> dict:
    """Mueve el corte entre un pago y el siguiente."""
    return cortes.mover_corte(
        mes=body.mes, key=_llave(body), izq_pago_id=body.izq_pago_id, fecha=body.fecha,
        version=body.version, usuario=usuario,
    )


@app.post("/v1/comisionesbi/cortes/mover-borde")
def post_cortes_mover_borde(body: CortesMoverBordeBody, usuario: str = Depends(editor)) -> dict:
    """Mueve un borde que no es un corte compartido (extremo de la fila, hueco o traslape)."""
    return cortes.mover_borde(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, borde=body.borde, fecha=body.fecha,
        version=body.version, usuario=usuario,
    )


@app.post("/v1/comisionesbi/cortes/sugerencia/aplicar")
def post_cortes_aplicar(body: CortesAplicarBody, usuario: str = Depends(editor)) -> dict:
    return cortes.aplicar_sugerencia(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id,
        cambios_vistos=[c.model_dump() for c in body.cambios] if body.cambios is not None else None,
        version=body.version, usuario=usuario, dias_vistos=body.dias, bloques_vistos=body.bloques,
    )


@app.post("/v1/comisionesbi/cortes/sugerencia/descartar")
def post_cortes_descartar(body: CortesPagoBody, usuario: str = Depends(editor)) -> dict:
    return cortes.descartar_sugerencia(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/sugerencia/recuperar")
def post_cortes_recuperar(body: CortesPagoBody, usuario: str = Depends(editor)) -> dict:
    return cortes.recuperar_sugerencia(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/restablecer")
def post_cortes_restablecer(body: CortesPagoBody, usuario: str = Depends(editor)) -> dict:
    """Vuelve la ventana de un pago a la que propone el texto."""
    return cortes.restablecer_pago(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/consolidar")
def post_cortes_consolidar(body: CortesPagoBody, usuario: str = Depends(editor)) -> dict:
    """Congela un pago: guarda su ventana, lo pagado y lo calculado, y sus cortes dejan de moverse."""
    return cortes.consolidar(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/reabrir")
def post_cortes_reabrir(body: CortesReabrirBody, usuario: str = Depends(editor)) -> dict:
    """Quita la foto de uno o más pagos consolidados."""
    return cortes.reabrir(
        mes=body.mes, key=_llave(body), pago_ids=body.pago_ids, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/consolidar-lote")
def post_cortes_consolidar_lote(body: CortesLoteBody, usuario: str = Depends(editor)) -> dict:
    """Consolida lo que cuadra, de izquierda a derecha, en las filas pedidas."""
    return cortes.consolidar_lote(mes=body.mes, desde=body.desde, hasta=body.hasta, fila_ids=body.fila_ids, usuario=usuario)


@app.post("/v1/comisionesbi/cortes/fijar-ventana")
def post_cortes_fijar_ventana(body: CortesVentanaBody, usuario: str = Depends(editor)) -> dict:
    """Da inicio y fin a un pago cuyo texto no trae fechas legibles."""
    return cortes.fijar_ventana(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, ini=body.ini, fin=body.fin,
        version=body.version, usuario=usuario,
    )


@app.post("/v1/comisionesbi/cortes/asignar-dias")
def post_cortes_asignar_dias(body: CortesDiasBody, usuario: str = Depends(editor)) -> dict:
    """Asigna a mano días de cierre de mes a un pago (o los quita con lista vacía)."""
    return cortes.asignar_dias(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, dias=body.dias, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/mover-skus")
def post_cortes_mover_skus(body: CortesSkusBody, usuario: str = Depends(editor)) -> dict:
    """Mueve una semana de los 4 SKUs de Botana al pago que la pagó (o la deja sin pagar)."""
    return cortes.mover_skus(
        mes=body.mes, key=_llave(body), bloques_ini=body.bloques_ini, pago_id=body.pago_id or None,
        version=body.version, usuario=usuario,
    )


@app.post("/v1/comisionesbi/cortes/comentar")
def post_cortes_comentar(body: CortesComentarBody, usuario: str = Depends(editor)) -> dict:
    """Deja un comentario en el pago (con quién y cuándo)."""
    return cortes.comentar(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, texto=body.texto, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/borrar-comentario")
def post_cortes_borrar_comentario(body: CortesBorrarComentarioBody, usuario: str = Depends(editor)) -> dict:
    """Borra un comentario propio."""
    return cortes.borrar_comentario(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, comentario_id=body.comentario_id,
        version=body.version, usuario=usuario,
    )


@app.post("/v1/comisionesbi/cortes/quitar-huerfano")
def post_cortes_quitar_huerfano(body: CortesPagoBody, usuario: str = Depends(editor)) -> dict:
    """Borra el ajuste o la foto de un documento que ya no existe en SAP."""
    return cortes.quitar_huerfano(
        mes=body.mes, key=_llave(body), pago_id=body.pago_id, version=body.version, usuario=usuario
    )


@app.post("/v1/comisionesbi/cortes/exportar")
def post_cortes_exportar(body: CortesExportarBody) -> dict:
    """El detalle de un pago (por producto, por día y por línea de factura) para su Excel."""
    if body.fin < body.ini or (body.fin - body.ini).days > 62:
        raise HTTPException(status_code=422, detail="La ventana del pago no es válida.")
    return cortes.build_export_pago(
        sociedad=body.sociedad, comisionista_id=body.comisionista_id, division_code=body.division_code,
        ini=body.ini, fin=body.fin, dias=body.dias,
        skus=[(b.ini, b.fin) for b in body.skus],
    )


@app.post("/v1/comisionesbi/cortes/lineas")
def post_cortes_lineas(body: CortesLineasBody) -> dict:
    """Pagado por línea del pedido contra calculado por familia de un pago de Botana."""
    if body.fin < body.ini or (body.fin - body.ini).days > 62:
        raise HTTPException(status_code=422, detail="La ventana del pago no es válida.")
    return cortes.build_lineas_pago(
        sociedad=body.sociedad, comisionista_id=body.comisionista_id, division_code=body.division_code,
        docs=body.docs, ini=body.ini, fin=body.fin, dias=body.dias, skus=[(b.ini, b.fin) for b in body.skus],
    )


@app.post("/v1/comisionesbi/cortes/anio")
def post_cortes_anio(body: CortesAnioBody) -> dict:
    """Pagado y calculado del año por división (cualquier rol puede verlo)."""
    return cortes.build_anio(anio=body.anio)


@app.post("/v1/comisionesbi/cortes/historial")
def post_cortes_historial(body: CortesHistorialBody) -> dict:
    """Los últimos cambios de una fila (cualquier rol puede verlos)."""
    return cortes.build_historial(key=_llave(body), limite=body.limite)
