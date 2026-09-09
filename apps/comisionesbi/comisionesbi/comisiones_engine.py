"""Módulo 1 · Comisión — cuánto se ha devengado, y qué falta para el resto.

Lee `ZZ_PRUEBAS.DBC_gold_comision_diaria_v2` (`Datos/sql/v1_comision_dbc_gold_v2.sql`),
agregado sobre `dbc_comisiones_calculadas_cobro`
(`Datos/sql/v1_comision_dbc_completo_cobro.sql`) — reemplaza a partir del
2026-09-01 la cadena anterior (`v1_comision_linea` → `DBC_gold_comision_diaria`,
`data/consultas/`), validada contra ella antes del cambio (mismo total
facturado al peso, una vez igualadas fechas). Cobertura de tarifa subió de
~82% a ~92% del facturado en alcance.

`base_unidad`/`cantidad_base` (2026-09-07, confirmado con la distribución real
de `sales_unit`): ya vienen resueltas para las 5 divisiones — kg en H/IA (vía
`net_weight`), pieza en A/L, paquete en BO. Ya no es un pendiente.

`comisionista` (2026-09-08): cambió de fuente, de `DBC_dim_almacen_oficina`
(sin `persona` para Botana/Abarrotes, de ahí el 0% de esas 2 divisiones) a
`DBC_dim_comisionista`, cruzada por sociedad+oficina con `persona_cod` como
llave real — ver `v1_comision_dbc_gold_v2.sql`. Cubre ~87% de las
combinaciones que trae la facturación, sin importar la división: el hueco ya
no es "0% en Botana y Abarrotes, resto bien", es un resto repartido entre
todas.
Las 4 oficinas de venta directa/bodega (0001/0174/0175/0181, ~$51 M) ya NO
cuentan en `monto_total`: se excluyen desde el origen (antes se incluían y se
marcaban como bloqueadas). No se consulta la tabla base directamente porque
cada consulta escanea varios GiB: filtrar en pantalla sobre eso sería pagar
de más por clic. La tabla gold son unos MB.

ESTE MÓDULO DEVUELVE UN NÚMERO INCOMPLETO, Y ESO NO ES UN FALLO
El resto está bloqueado por cosas concretas que el cliente tiene que contestar.
La respuesta trae por eso dos bloques que hay que leer juntos:

  `totales`   lo devengado, y sobre cuánto facturado se ha podido calcular.
  `bloqueado` por qué el resto no entra, cuánto factura cada motivo, y cuánto
              valdría si entrara.

Enseñar el total sin el segundo bloque sería exactamente cómo se construye una
cifra que nadie puede cuadrar seis meses después. La pantalla los enseña juntos
y el motor los devuelve juntos: no hay forma de pedir uno sin el otro.

TRES COSAS QUE NO SON EVIDENTES:

1. LA COMISIÓN SE CALCULA SOBRE LO FACTURADO, aunque se pague sobre lo cobrado.
   No es una decisión de diseño sino de datos: la fuente de cobro (2026-09-07:
   `sap_bsad_cleared_items`, antes `sap_pago`) da una fila por factura, sin
   material, así que sobre lo cobrado no hay SET y no hay tarifa posible.
   `comision_cobrada`/`monto_cobrado` sí vienen prorrateados por línea (no por
   documento completo, ver `v1_comision_dbc_completo_cobro.sql`), pero aunque
   `sap_bsad_cleared_items` cubre ~87% del facturado (antes ~17% con
   `sap_pago`) sigue sin ver el 100% del cobro real — por eso NO se llaman
   "pagable": son el suelo conocido.

2. `cantidad_base` MEZCLA KILOS Y CAJAS si se suma entre divisiones. Confirmado
   2026-09-07 para las 5: kg en H/IA (peso real), pieza en A/L, paquete en BO
   — sumar entre divisiones sigue sin tener sentido, pero ya no falta ningún
   dato por división.

3. `comision_min`/`comision_max` (horquilla de tarifas en conflicto) ya no
   aplican con esta fuente: verificado que las tablas de tarifa oficial
   (`proan_ZTSD_OV_COM_*`) no traen llaves duplicadas. Vienen siempre NULL.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from datetime import date
from typing import NamedTuple

from comisionesbi.db import BigQueryError, run_query

log = logging.getLogger(__name__)

_TABLA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_comision_diaria_v2`"

# Mismo patrón que flujo_engine: `(@x IS NULL OR columna = @x)` para que un solo
# SQL sirva a todas las combinaciones de filtro sin construir la cadena a trozos.
_DETALLE_SQL = f"""
SELECT
  fecha, sociedad, division_code, division, cedis, oficina, almacen, comisionista,
  tipo_venta, `set`, base_unidad, comision_estado,
  num_lineas, monto_total, cantidad_base_total,
  comision_total, comision_min_total, comision_max_total,
  comision_cobrada, monto_cobrado, lineas_sin_importe
FROM {_TABLA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@cedis IS NULL OR cedis = @cedis)
  AND (@comisionista IS NULL OR comisionista = @comisionista)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
"""

# Sin filtro de fechas a propósito: "hasta cuándo hay datos" es una propiedad
# del dataset, no del rango que se esté mirando. Filtrada devolvería siempre el
# final del rango pedido y no avisaría de nada.
_COBERTURA_SQL = f"""
SELECT MIN(fecha) AS desde, MAX(fecha) AS hasta FROM {_TABLA}
"""

CALCULADA = "calculada"


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


def cobertura() -> dict:
    filas = run_query(_COBERTURA_SQL, "la cobertura de comisión")
    if not filas:
        return {}
    return {"desde": _iso(filas[0]["desde"]), "hasta": _iso(filas[0]["hasta"])}


def _nuevo() -> dict:
    return {
        "num_lineas": 0,
        "monto": 0.0,
        "comision": 0.0,
        "comision_con_cobro": 0.0,
        # Cuánto del importe de este grupo llegó a tener tarifa. Sin esto, un
        # comisionista con la mitad de su venta bloqueada es indistinguible de
        # uno con poca venta.
        "monto_calculable": 0.0,
        # Lado facturado de `comision_con_cobro` (2026-09-09, pedido de
        # Silvana): ya se traía en `_DETALLE_SQL` pero nunca se sumaba. Mismo
        # límite que `comision_con_cobro` -- suelo conocido, no "lo pagable"
        # (ver el punto 1 del docstring del módulo).
        "monto_cobrado": 0.0,
    }


def _acumular(destino: dict, clave, fila: dict) -> None:
    a = destino[clave]
    a["num_lineas"] += fila["num_lineas"] or 0
    a["monto"] += fila["monto_total"] or 0.0
    a["comision"] += fila["comision_total"] or 0.0
    a["comision_con_cobro"] += fila["comision_cobrada"] or 0.0
    a["monto_cobrado"] += fila["monto_cobrado"] or 0.0
    if fila["comision_estado"] == CALCULADA:
        a["monto_calculable"] += fila["monto_total"] or 0.0


def _ordenadas(agrupado: dict, clave: str) -> list[dict]:
    """Filas ordenadas por comisión descendente, con los nulos al final.

    Por comisión y no alfabéticamente porque la pregunta que trae a alguien a
    esta pantalla es "a quién hay que pagarle más", no "quién empieza por A".
    """
    return [
        {clave: valor, **datos}
        for valor, datos in sorted(
            agrupado.items(),
            key=lambda item: (item[0] is None, -item[1]["comision"], item[0] or ""),
        )
    ]


# ─── Desglose para la cascada de la pantalla ──────────────────────────────
#
# El GRANO MÁS FINO que tiene sentido enseñar, y no es una elección estética: la
# tarifa se busca por división + oficina + SET + tipo de venta, así que por
# debajo de esa llave no hay nada que cuadrar contra la hoja del cliente, y por
# encima hay sumas que no se pueden verificar contra nada.
#
# Va SIN `fecha` y SIN `comision_estado`. Sin fecha porque la cascada es de
# liquidación, no de serie temporal, y con ella el desglose se multiplicaría por
# los días del periodo. Sin estado porque partiría cada hoja en dos filas —una
# calculada y otra bloqueada— cuando lo que hace falta es lo contrario: una fila
# por llave de tarifa, y dentro `monto_calculable` diciendo cuánto de ella llegó
# a tener tarifa.
#
# Las dos cascadas de la pantalla son ANIDAMIENTOS DISTINTOS DE ESTAS MISMAS
# COLUMNAS (por división: división → CEDIS → comisionista → hoja; por
# comisionista: comisionista → división → hoja), así que un solo array las sirve
# a las dos y el navegador no tiene que pedir nada al abrir un nodo.
DIMENSIONES_DESGLOSE = (
    "sociedad",
    "comisionista",
    "division_code",
    "division",
    "cedis",
    "oficina",
    "set",
    "tipo_venta",
    "base_unidad",
)


def _desglose(filas: list[dict], dimensiones: tuple[str, ...]) -> list[dict]:
    """Agrega por la llave compuesta que se le pida.

    `base_unidad` TIENE que ir en la llave, y se comprueba en vez de confiar:
    sin ella `cantidad_base` sumaría kilos con cajas (punto 2 del docstring del
    módulo), y saldría un número que parece una cantidad y no lo es.
    """
    if "base_unidad" not in dimensiones:
        raise ValueError(
            "el desglose necesita `base_unidad` en la llave: sin ella la cantidad mezcla unidades"
        )

    acumulado: dict = defaultdict(lambda: {**_nuevo(), "cantidad_base": 0.0})
    for fila in filas:
        clave = tuple(fila[dimension] for dimension in dimensiones)
        _acumular(acumulado, clave, fila)
        acumulado[clave]["cantidad_base"] += fila["cantidad_base_total"] or 0.0

    # Por comisión descendente y sin comparar las claves entre sí: llevan nulos
    # dentro y `None < str` reventaría. `sorted` es estable, así que el empate lo
    # rompe el orden de aparición.
    return [
        {**dict(zip(dimensiones, clave)), **datos}
        for clave, datos in sorted(acumulado.items(), key=lambda item: -item[1]["comision"])
    ]


# ─── Desglose de lo bloqueado ──────────────────────────────────────────────
# La llave de tarifa (sociedad + división + oficina + SET + tipo de venta)
# MÁS `almacen` -- ese último no hace falta para "sin tarifa para esa llave"
# (esa llave no lo usa), pero sí para "sin CEDIS/tipo de venta": esa se
# resuelve por almacén+oficina, no por SET+tipo de venta (que ahí es
# justamente lo que falta). Se agrupa también por motivo -- para que la
# pantalla pueda abrir cualquiera de los dos y enseñar exactamente qué llaves
# lo componen, en vez de solo el total.
def _bloqueado_desglose(filas: list[dict]) -> list[dict]:
    acumulado: dict = defaultdict(lambda: {"num_lineas": 0, "monto": 0.0})
    nombre_division: dict = {}
    for fila in filas:
        motivo = fila["comision_estado"]
        if motivo == CALCULADA:
            continue
        clave = (
            motivo, fila["sociedad"], fila["division_code"], fila["oficina"],
            fila["almacen"], fila["set"], fila["tipo_venta"],
        )
        a = acumulado[clave]
        a["num_lineas"] += fila["num_lineas"] or 0
        a["monto"] += fila["monto_total"] or 0.0
        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]

    dimensiones = ("motivo", "sociedad", "division_code", "oficina", "almacen", "set", "tipo_venta")
    return [
        {
            **dict(zip(dimensiones, clave)),
            "division": nombre_division.get(clave[2]),
            **datos,
        }
        for clave, datos in sorted(acumulado.items(), key=lambda item: -item[1]["monto"])
    ]


def _build_report(
    *,
    division: str | None,
    cedis: str | None,
    comisionista: str | None,
    sociedad: str | None,
    start_date: date,
    end_date: date,
) -> dict:
    """Una sola consulta y las agregaciones en memoria, igual que en el flujo:
    la tabla gold entera son ~12 MB, así que traer el trozo filtrado y agrupar
    aquí sale más barato que lanzar una consulta por agrupación."""
    filas = run_query(
        _DETALLE_SQL,
        "el informe de comisión",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "cedis": ("STRING", cedis),
            "comisionista": ("STRING", comisionista),
            "sociedad": ("STRING", sociedad),
        },
    )

    por_comisionista: dict = defaultdict(_nuevo)
    por_division: dict = defaultdict(_nuevo)
    por_cedis: dict = defaultdict(_nuevo)
    por_fecha: dict = defaultdict(_nuevo)
    por_set: dict = defaultdict(_nuevo)
    # El objetivo del proyecto pide la comisión "según tipo de venta" (ruta,
    # mayoreo, medio mayoreo…), y el tipo ya venía en el grano de la tabla gold
    # sin que nadie lo agregara.
    por_tipo_venta: dict = defaultdict(_nuevo)
    # Huevo se factura por dos sociedades (DBC y PAN) y la comisión de PAN es
    # la mayor parte del total. Sin este desglose, el número de huevo en
    # pantalla mezcla dos negocios distintos sin decirlo.
    por_sociedad: dict = defaultdict(_nuevo)
    # `cantidad_base` no se suma entre unidades (punto 2 del docstring): la
    # clave lleva la unidad dentro.
    por_unidad: dict = defaultdict(float)
    nombre_division: dict = {}

    bloqueado: dict = defaultdict(
        lambda: {"num_lineas": 0, "monto": 0.0, "comision_min": 0.0, "comision_max": 0.0}
    )

    total = _nuevo()
    lineas_sin_importe = 0

    for fila in filas:
        _acumular(por_comisionista, fila["comisionista"], fila)
        _acumular(por_division, fila["division_code"], fila)
        _acumular(por_cedis, fila["cedis"], fila)
        _acumular(por_fecha, _iso(fila["fecha"]), fila)
        _acumular(por_set, fila["set"], fila)
        _acumular(por_tipo_venta, fila["tipo_venta"], fila)
        _acumular(por_sociedad, fila["sociedad"], fila)
        _acumular({None: total}, None, fila)
        lineas_sin_importe += fila["lineas_sin_importe"] or 0

        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]

        if fila["base_unidad"] and fila["cantidad_base_total"] is not None:
            por_unidad[fila["base_unidad"]] += fila["cantidad_base_total"]

        estado = fila["comision_estado"]
        if estado != CALCULADA:
            b = bloqueado[estado]
            b["num_lineas"] += fila["num_lineas"] or 0
            b["monto"] += fila["monto_total"] or 0.0
            # La horquilla solo existe donde hay conflicto de tarifas; en el
            # resto de bloqueos es NULL y se queda en cero, que es honesto:
            # todavía no se sabe cuánto valdría.
            b["comision_min"] += fila["comision_min_total"] or 0.0
            b["comision_max"] += fila["comision_max_total"] or 0.0

    divisiones = _ordenadas(por_division, "division_code")
    for entrada in divisiones:
        entrada["division"] = nombre_division.get(entrada["division_code"])

    monto = total["monto"]
    return {
        "cobertura": cobertura(),
        "totales": {
            **total,
            # El dato que evita leer el total como si fuera completo.
            "pct_calculable": (total["monto_calculable"] / monto * 100) if monto else 0.0,
            "lineas_sin_importe": lineas_sin_importe,
        },
        "por_comisionista": _ordenadas(por_comisionista, "comisionista"),
        "por_division": divisiones,
        "por_cedis": _ordenadas(por_cedis, "cedis"),
        "por_set": _ordenadas(por_set, "set"),
        "por_tipo_venta": _ordenadas(por_tipo_venta, "tipo_venta"),
        "por_sociedad": _ordenadas(por_sociedad, "sociedad"),
        # La cascada de la pantalla se construye con esto, sin más viajes.
        "desglose": _desglose(filas, DIMENSIONES_DESGLOSE),
        # Por fecha va en orden cronológico, no por comisión: es una serie.
        "por_fecha": [
            {"fecha": fecha, **datos} for fecha, datos in sorted(por_fecha.items())
        ],
        "cantidad_por_unidad": [
            {"base_unidad": unidad, "cantidad": cantidad}
            for unidad, cantidad in sorted(por_unidad.items())
        ],
        # Ordenado por importe bloqueado: lo primero de la lista es lo que más
        # rinde desbloquear.
        "bloqueado": [
            {"motivo": motivo, **datos}
            for motivo, datos in sorted(bloqueado.items(), key=lambda i: -i[1]["monto"])
        ],
        # Detalle por llave detrás de cada motivo de "bloqueado" -- la pantalla
        # lo filtra por motivo al abrir esa fila, sin pedir nada más.
        "bloqueado_desglose": _bloqueado_desglose(filas),
    }


# ─── Caché en memoria del informe ─────────────────────────────────────────
# Mismo patrón que `catalog_engine.catalog()` (ver ese módulo para el porqué
# de cada detalle: lock durante la consulta, un fallo no se cachea, se sirve
# copia caducada si BigQuery falla). La diferencia es la llave: el catálogo no
# tiene filtros, así que una sola entrada le basta; aquí cada combinación de
# división/CEDIS/comisionista/rango de fechas es su propio informe, así que
# el caché es un diccionario por combinación, no un único valor. TTL en horas
# a propósito: la tabla gold se actualiza a diario, así que servir un informe
# de un par de horas no es servir un número viejo de verdad.

_REPORT_CACHE_TTL_POR_DEFECTO = 4 * 3600

_report_cache_lock = threading.Lock()


class _ReportCacheEntry(NamedTuple):
    expires_at: float
    report: dict


_report_cache: dict[tuple, _ReportCacheEntry] = {}


def _now() -> float:
    """Reloj monotónico — inmune a saltos de hora, y fijable desde los tests."""
    return time.monotonic()


def _report_cache_ttl_seconds() -> int:
    """TTL de la caché. `0` (o negativo) la desactiva; valor ilegible → defecto."""
    try:
        ttl = int(os.getenv("REPORT_CACHE_TTL_SECONDS", ""))
    except ValueError:
        return _REPORT_CACHE_TTL_POR_DEFECTO
    return max(ttl, 0)


def invalidate_report_cache() -> None:
    """Fuerza la relectura en la siguiente llamada. Para operativa y pruebas."""
    global _report_cache
    with _report_cache_lock:
        _report_cache = {}


def build_report(
    *,
    division: str | None,
    cedis: str | None,
    comisionista: str | None = None,
    sociedad: str | None = None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/report. Cacheado con TTL por
    combinación de filtros -- ver el comentario de arriba."""
    clave = (division, cedis, comisionista, sociedad,
             start_date.isoformat(), end_date.isoformat())

    ttl = _report_cache_ttl_seconds()
    if ttl == 0:
        # Desactivada de verdad: no se guarda nada, así que tampoco hay copia
        # caducada que servir si BigQuery falla.
        return _build_report(
            division=division, cedis=cedis, comisionista=comisionista,
            sociedad=sociedad, start_date=start_date, end_date=end_date,
        )

    with _report_cache_lock:
        entrada = _report_cache.get(clave)
        if entrada is not None and entrada.expires_at > _now():
            return entrada.report

        try:
            informe = _build_report(
                division=division, cedis=cedis, comisionista=comisionista,
                sociedad=sociedad, start_date=start_date, end_date=end_date,
            )
        except BigQueryError:
            if entrada is None:
                raise
            log.warning(
                "Informe de comisión no recargable desde BigQuery: se sirve la copia caducada",
                exc_info=True,
            )
            return entrada.report

        _report_cache[clave] = _ReportCacheEntry(expires_at=_now() + ttl, report=informe)
        return informe
