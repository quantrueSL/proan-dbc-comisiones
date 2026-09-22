"""Módulo 0 · Flujo de producto — vendido, facturado y cobrado.

Lee `ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`, la tabla agregada por día que
construye `data/consultas/DBC_gold_flujo_producto_diario.sql`. No se consulta la
vista `v1_flujo_producto_dbc_resumen_diario` de Silvana directamente porque cada
consulta a esa vista escanea 8,98 GiB (rehace el UNION ALL de las tres capas
desde SAP); la tabla gold ocupa 4,7 MB. Cuando el flujo se orqueste en Airflow,
ese SQL pasa a ser el DAG diario y aquí no cambia nada.

TRES COSAS QUE ESTE MÓDULO TIENE QUE HACER BIEN, y que no son evidentes:

1. `cantidad` (la cruda, `invoiced_quantity`/`sales_unit`) viene en unidades
   mezcladas (CS, PZA, PAQ, SAC, KG...) incluso dentro de una misma división,
   así que NO se usa para ninguna agregación de este módulo.
2. `cantidad_cajas` (`stockkeeping_units`) SÍ es comparable dentro de una
   división -- es la cantidad en la unidad de manejo real del material.
   Confirmado 2026-09-07 con la distribución por división (monto DBC 2026):
   H 99.97% CS -> caja; IA ~100% SAC -> saco; BO 99.4% PAQ -> paquete; A y L
   100% PZA -> pieza. `cantidad_por_unidad` usa esto (no la unidad cruda) y
   agrupa por división para no sumar cajas de huevo con sacos de alimento.
   Sigue pudiendo ser NULL --"aquí no aplica"-- y por eso no se convierte en
   cero al agregar.
3. Cada fase tiene su propia fecha de corte y no tienen por qué coincidir:
   "vendido" sale de `sap_VBAP`, cuya carga se ha quedado atrás más de una vez
   (ver data/notas/hallazgos.md). Aquí no se escribe ninguna fecha concreta
   porque envejece mal: la de verdad la devuelve `cobertura`, y por eso este
   módulo la devuelve siempre. Sin ese dato, la pantalla dibujaría ceros donde
   lo que falta es el dato, y parecería un desplome de ventas en vez de una
   laguna.

Falta la cuarta capa, traspasos: depende de validar `sap_mseg` contra MB51, que
está bloqueado por el código BWART pendiente del cliente.

`sociedad` (2026-09-10): DBC o PAN, mismo alcance que Comisiones (PAN solo
huevo, solo combinaciones con tarifa oficial -- ver `v1_flujo_producto_dbc.sql`
sección 2 para el porqué). Se agregó porque Comisiones ya sumaba DBC+PAN
($2,832.8 M) y esta pantalla se había quedado en solo-DBC ($770.7 M): los dos
totales parecían contradecirse sin serlo.

2026-09-22: "vendido" también trae PAN. Se creía limitación de la fuente
(VBAP/VBAK sin sociedad) pero era un filtro de plantas desactualizado -- PAN sí
vende huevo por su planta (PANF), y con el mismo criterio `alcance_pan` de
facturado/cobrado (no uno más laxo, que sobrestimaba vendido 3,6x). Ver el
encabezado de `v1_flujo_producto_dbc.sql` para la comparación con números.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import NamedTuple

from comisionesbi.db import BigQueryError, run_query

log = logging.getLogger(__name__)

_TABLA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`"

# Unidad de manejo real por división (confirmado 2026-09-07, ver docstring del
# módulo). Solo cubre las 5 divisiones que opera DBC a propósito -- una
# división fuera de operación no debe aparecer en "cantidad por unidad".
_UNIDAD_MANEJO = {"H": "caja", "IA": "saco", "BO": "paquete", "A": "pieza", "L": "pieza"}

# Los filtros opcionales usan `(@x IS NULL OR columna = @x)`: un solo SQL sirve
# para todas las combinaciones, sin construir la cadena a trozos.
_DETALLE_SQL = f"""
SELECT
  fase, sociedad, fecha, division_code, division, cedis, tipo_venta, unidad,
  almacen_central, division_en_operacion,
  num_lineas, cantidad_total, cantidad_cajas_total, monto_total
FROM {_TABLA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@cedis IS NULL OR cedis = @cedis)
  AND (@tipo_venta IS NULL OR tipo_venta = @tipo_venta)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
"""

# La cobertura se calcula sobre la tabla ENTERA, sin los filtros de fecha: "hasta
# cuándo hay datos" es una propiedad del dataset, no del rango que se esté
# mirando. Si se filtrara, siempre devolvería el final del rango pedido y no
# avisaría de nada.
_COBERTURA_SQL = f"""
SELECT fase, MIN(fecha) AS desde, MAX(fecha) AS hasta
FROM {_TABLA}
GROUP BY fase
"""


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


def _cobertura_query() -> dict[str, dict]:
    filas = run_query(_COBERTURA_SQL, "la cobertura del flujo de producto")
    return {
        fila["fase"]: {"desde": _iso(fila["desde"]), "hasta": _iso(fila["hasta"])}
        for fila in filas
    }


# ─── Caché en memoria de la cobertura ─────────────────────────────────────
# Mismo patrón y mismo motivo que `comisiones_engine.cobertura()`: no depende
# de los filtros del informe (siempre la misma consulta), así que va aparte
# con su propio TTL en vez de recalcularse en cada combinación de filtros
# nueva -- antes vivía "dentro" de `build_flujo` y se repetía en cada llamada.
_COBERTURA_CACHE_TTL_POR_DEFECTO = 3600

_cobertura_cache_lock = threading.Lock()


class _CoberturaCacheEntry(NamedTuple):
    expires_at: float
    cobertura: dict


_cobertura_cache: _CoberturaCacheEntry | None = None


def _now() -> float:
    """Reloj monotónico — inmune a saltos de hora, y fijable desde los tests."""
    return time.monotonic()


def _cobertura_cache_ttl_seconds() -> int:
    """TTL de la caché. `0` (o negativo) la desactiva; valor ilegible → defecto."""
    try:
        ttl = int(os.getenv("FLUJO_COBERTURA_CACHE_TTL_SECONDS", ""))
    except ValueError:
        return _COBERTURA_CACHE_TTL_POR_DEFECTO
    return max(ttl, 0)


def cobertura() -> dict[str, dict]:
    """Rango de fechas con datos de cada fase. Ver punto 3 del docstring del módulo."""
    global _cobertura_cache

    ttl = _cobertura_cache_ttl_seconds()
    if ttl == 0:
        return _cobertura_query()

    with _cobertura_cache_lock:
        if _cobertura_cache is not None and _cobertura_cache.expires_at > _now():
            return _cobertura_cache.cobertura

        try:
            resultado = _cobertura_query()
        except BigQueryError:
            if _cobertura_cache is None:
                raise
            log.warning(
                "Cobertura de flujo no recargable desde BigQuery: se sirve la copia caducada",
                exc_info=True,
            )
            return _cobertura_cache.cobertura

        _cobertura_cache = _CoberturaCacheEntry(expires_at=_now() + ttl, cobertura=resultado)
        return resultado


def invalidate_cobertura_cache() -> None:
    """Fuerza la relectura en la siguiente llamada. Para operativa y pruebas."""
    global _cobertura_cache
    with _cobertura_cache_lock:
        _cobertura_cache = None


class _CamposFila(NamedTuple):
    """Los 3 valores escalares de una fila que alimentan cualquier acumulador
    (`_nuevo()`), ya extraídos del diccionario de BigQuery -- mismo motivo que
    `comisiones_engine._CamposFila`: el loop principal llama `_acumular` 6
    veces por fila (una por agrupación: fase, fecha, CEDIS, división, tipo de
    venta, sociedad), y sin esto cada llamada releería los mismos 3 campos
    desde cero."""

    num_lineas: int
    monto_total: float
    cantidad_cajas_total: float | None


def _campos(fila: dict) -> _CamposFila:
    return _CamposFila(
        num_lineas=fila["num_lineas"] or 0,
        monto_total=fila["monto_total"] or 0.0,
        cantidad_cajas_total=fila["cantidad_cajas_total"],
    )


def _acumular(destino: dict, clave, campos: _CamposFila) -> None:
    acumulado = destino[clave]
    acumulado["num_lineas"] += campos.num_lineas
    acumulado["monto_total"] += campos.monto_total
    # Las cajas ya vienen en las tres fases, pero el None se respeta igual: si
    # una fase no trae el dato se queda en None en vez de 0, para que la interfaz
    # distinga "cero cajas" de "aquí no aplica".
    if campos.cantidad_cajas_total is not None:
        actual = acumulado["cantidad_cajas_total"] or 0.0
        acumulado["cantidad_cajas_total"] = actual + campos.cantidad_cajas_total


def _nuevo() -> dict:
    return {"num_lineas": 0, "monto_total": 0.0, "cantidad_cajas_total": None}


def _ordenadas(agrupado: dict, clave: str) -> list[dict]:
    """Convierte {(valor, fase): totales} en filas, con los nulos al final."""
    return [
        {clave: valor, "fase": fase, **datos}
        for (valor, fase), datos in sorted(
            agrupado.items(), key=lambda item: (item[0][0] is None, item[0][0] or "", item[0][1])
        )
    ]


def _build_flujo(
    *,
    division: str | None,
    cedis: str | None,
    tipo_venta: str | None,
    sociedad: str | None,
    start_date: date,
    end_date: date,
) -> dict:
    """Una sola consulta al detalle diario y las agregaciones en memoria: la
    tabla gold entera son 4,7 MB, así que traer el trozo filtrado y agrupar
    aquí sale más barato que lanzar una consulta por agrupación.

    Se devuelven las agrupaciones por CEDIS, división y tipo de venta porque la
    pantalla deja pulsar sobre ellas para filtrar el resto; el nombre de la
    división viaja junto a su código para que la interfaz pueda enseñar "Huevo"
    y filtrar por "H" sin tener que cruzar nada.

    `sociedad` (2026-09-10, DBC o PAN, con vendido incluido desde 2026-09-22)
    se agrega junto con las demás porque sin este desglose, alguien que
    compare esta pantalla con Comisiones no tiene forma de ver por qué el
    total no es idéntico entre fases.

    `cobertura()` tiene su propia caché (no depende de los filtros de este
    informe), así que normalmente devuelve al instante. El detalle se lanza en
    un hilo aparte para que, en el caso raro de que también le toque ir a
    BigQuery, corra en paralelo con el detalle en vez de encolarse detrás.
    """
    with ThreadPoolExecutor(max_workers=1) as executor:
        filas_future = executor.submit(
            run_query,
            _DETALLE_SQL,
            "el flujo de producto",
            {
                "start": ("DATE", start_date),
                "end": ("DATE", end_date),
                "division": ("STRING", division),
                "cedis": ("STRING", cedis),
                "tipo_venta": ("STRING", tipo_venta),
                "sociedad": ("STRING", sociedad),
            },
        )
        cobertura_resultado = cobertura()
        filas = filas_future.result()

    por_fase: dict = defaultdict(_nuevo)
    por_fecha: dict = defaultdict(_nuevo)
    por_cedis: dict = defaultdict(_nuevo)
    por_division: dict = defaultdict(_nuevo)
    por_tipo_venta: dict = defaultdict(_nuevo)
    por_sociedad: dict = defaultdict(_nuevo)
    nombre_division: dict = {}
    # Cantidad por unidad de manejo (punto 2 del docstring): la clave lleva
    # división Y unidad, para que la tabla pueda distinguir cajas de huevo de
    # sacos de alimento aunque el gráfico las sume por unidad.
    por_unidad: dict = defaultdict(float)

    # Los cuatro almacenes centrales (BO28, BO01, H723, H793) salen de la
    # pantalla: el cliente confirmó el 25/08/2026 que no pasan por ningún CEDIS
    # y no generan comisión, así que contarlos en un desglose por CEDIS no
    # significa nada. Pero NO se descartan en silencio — se suman aparte y se
    # devuelven, porque son el 47% de lo que factura DBC en las divisiones en
    # operación y la pantalla tiene que poder decir cuánto está dejando fuera.
    #
    # Se acumulan POR FASE, no en un único saco. Sumar vendido + facturado +
    # cobrado da un número que no existe: es el mismo producto contado tres
    # veces según avanza por el embudo. La cifra que se enseña es la de
    # facturado, que es la que alguien puede contrastar contra su propio SAP.
    excluidos: dict = defaultdict(_nuevo)

    for fila in filas:
        # Divisiones fuera de operación: se descartan sin más. El cliente
        # confirmó cuáles opera (H, BO, IA, A, L) y las demás las llevan otros
        # departamentos; se les nota en que entre el 82% y el 100% de su importe
        # no cruza con ningún CEDIS. No llevan aviso propio a propósito: la
        # pantalla desglosa por división, así que se ve de un vistazo cuáles
        # hay, y un segundo cartel encima del de almacenes centrales sería ruido.
        if fila.get("division_en_operacion") is False:
            continue
        # Extraído una sola vez y reutilizado en las 6 agrupaciones de abajo
        # (o en `excluidos`) -- ver el docstring de `_CamposFila`.
        campos = _campos(fila)
        if fila.get("almacen_central"):
            _acumular(excluidos, fila["fase"], campos)
            continue
        fase = fila["fase"]
        _acumular(por_fase, fase, campos)
        _acumular(por_fecha, (_iso(fila["fecha"]), fase), campos)
        _acumular(por_cedis, (fila["cedis"], fase), campos)
        _acumular(por_division, (fila["division_code"], fase), campos)
        _acumular(por_tipo_venta, (fila["tipo_venta"], fase), campos)
        _acumular(por_sociedad, (fila["sociedad"], fase), campos)
        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]
        unidad_manejo = _UNIDAD_MANEJO.get(fila["division_code"])
        if unidad_manejo and fila["cantidad_cajas_total"]:
            por_unidad[(fase, fila["division_code"], unidad_manejo)] += fila["cantidad_cajas_total"]

    divisiones = _ordenadas(por_division, "division_code")
    for entrada in divisiones:
        entrada["division"] = nombre_division.get(entrada["division_code"])

    # Facturado es la referencia: es la fase con monto confiable y la única
    # contrastable contra SAP. Si el periodo filtrado no tuviera facturado, se
    # devuelve el acumulador vacío en vez de inventar una cifra de otra fase.
    fuera = excluidos.get("facturado", _nuevo())
    dentro = por_fase.get("facturado", _nuevo())["monto_total"]
    total = fuera["monto_total"] + dentro

    return {
        "cobertura": cobertura_resultado,
        # Lo que se dejó fuera, para que la pantalla lo pueda decir con su cifra
        # en vez de con un número escrito a mano que envejece. Todo sobre
        # facturado: el importe, las líneas, las cajas y el porcentaje.
        "excluido_almacen_central": {
            **fuera,
            "pct_del_total": (fuera["monto_total"] / total * 100) if total else 0.0,
        },
        "resumen": [{"fase": fase, **datos} for fase, datos in sorted(por_fase.items())],
        "por_fecha": [
            {"fecha": fecha, "fase": fase, **datos}
            for (fecha, fase), datos in sorted(por_fecha.items())
        ],
        "por_cedis": _ordenadas(por_cedis, "cedis"),
        "por_division": divisiones,
        "por_tipo_venta": _ordenadas(por_tipo_venta, "tipo_venta"),
        "por_sociedad": _ordenadas(por_sociedad, "sociedad"),
        "cantidad_por_unidad": [
            {
                "fase": fase,
                "division_code": division_code,
                "division": nombre_division.get(division_code),
                "unidad": unidad,
                "cantidad_total": total,
            }
            for (fase, division_code, unidad), total in sorted(por_unidad.items())
        ],
    }


# ─── Caché en memoria del informe ─────────────────────────────────────────
# Mismo patrón que `comisiones_engine.build_report()` (ver ese módulo para el
# porqué de cada detalle: lock durante la consulta, un fallo no se cachea, se
# sirve copia caducada si BigQuery falla). Antes `build_flujo` no cacheaba
# nada -- a diferencia de Comisiones, cada visita a la pestaña, de cualquier
# usuario, disparaba BigQuery + Python desde cero, incluso en producción.

_FLUJO_CACHE_TTL_POR_DEFECTO = 4 * 3600

_flujo_cache_lock = threading.Lock()


class _FlujoCacheEntry(NamedTuple):
    expires_at: float
    flujo: dict


_flujo_cache: dict[tuple, _FlujoCacheEntry] = {}


def _flujo_cache_ttl_seconds() -> int:
    """TTL de la caché. `0` (o negativo) la desactiva; valor ilegible → defecto."""
    try:
        ttl = int(os.getenv("FLUJO_CACHE_TTL_SECONDS", ""))
    except ValueError:
        return _FLUJO_CACHE_TTL_POR_DEFECTO
    return max(ttl, 0)


def invalidate_flujo_cache() -> None:
    """Fuerza la relectura en la siguiente llamada. Para operativa y pruebas."""
    global _flujo_cache
    with _flujo_cache_lock:
        _flujo_cache = {}


def build_flujo(
    *,
    division: str | None,
    cedis: str | None,
    tipo_venta: str | None = None,
    sociedad: str | None = None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/flujo. Cacheado con TTL por
    combinación de filtros -- ver el comentario de arriba."""
    clave = (division, cedis, tipo_venta, sociedad,
             start_date.isoformat(), end_date.isoformat())

    ttl = _flujo_cache_ttl_seconds()
    if ttl == 0:
        # Desactivada de verdad: no se guarda nada, así que tampoco hay copia
        # caducada que servir si BigQuery falla.
        return _build_flujo(
            division=division, cedis=cedis, tipo_venta=tipo_venta,
            sociedad=sociedad, start_date=start_date, end_date=end_date,
        )

    with _flujo_cache_lock:
        entrada = _flujo_cache.get(clave)
        if entrada is not None and entrada.expires_at > _now():
            return entrada.flujo

        try:
            flujo = _build_flujo(
                division=division, cedis=cedis, tipo_venta=tipo_venta,
                sociedad=sociedad, start_date=start_date, end_date=end_date,
            )
        except BigQueryError:
            if entrada is None:
                raise
            log.warning(
                "Flujo de producto no recargable desde BigQuery: se sirve la copia caducada",
                exc_info=True,
            )
            return entrada.flujo

        _flujo_cache[clave] = _FlujoCacheEntry(expires_at=_now() + ttl, flujo=flujo)
        return flujo
