"""Módulo 0 · Flujo de producto — vendido, facturado y cobrado.

Lee `ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`, la tabla agregada por día que
construye `data/consultas/DBC_gold_flujo_producto_diario.sql`. No se consulta la
vista `v1_flujo_producto_dbc_resumen_diario` de Silvana directamente porque cada
consulta a esa vista escanea 8,98 GiB (rehace el UNION ALL de las tres capas
desde SAP); la tabla gold ocupa 4,7 MB. Cuando el flujo se orqueste en Airflow,
ese SQL pasa a ser el DAG diario y aquí no cambia nada.

TRES COSAS QUE ESTE MÓDULO TIENE QUE HACER BIEN, y que no son evidentes:

1. `cantidad` viene en unidades mezcladas (CS, PZA, PAQ, SAC, KG...), así que
   NO se suma entre unidades. Se devuelve desglosada por unidad y nunca como un
   único total.
2. `cantidad_cajas` solo existe en la fase "facturado" — es NULL en vendido y
   cobrado, porque sap_pago no llega a nivel de material y VBAP no tiene el
   equivalente a stockkeeping_units.
3. Cada fase tiene su propia fecha de corte, y hoy NO coinciden: `sap_VBAP`
   lleva sin datos nuevos desde el 20 de julio de 2026, así que "vendido" se
   corta ahí mientras facturado y cobrado siguen (ver
   data/notas/07_vbap_sin_datos_desde_20_julio.md). Por eso se devuelve
   `cobertura`: sin ese dato, la pantalla dibujaría ceros a partir del 21 de
   julio y parecería un desplome de ventas en vez de una laguna de datos.

Falta la cuarta capa, traspasos: depende de validar `sap_mseg` contra MB51, que
está bloqueado por el código BWART pendiente del cliente.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from comisionesbi.db import run_query

_TABLA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`"

# Los filtros opcionales usan `(@x IS NULL OR columna = @x)`: un solo SQL sirve
# para todas las combinaciones, sin construir la cadena a trozos.
_DETALLE_SQL = f"""
SELECT
  fase, fecha, division_code, division, cedis, tipo_venta, unidad,
  num_lineas, cantidad_total, cantidad_cajas_total, monto_total
FROM {_TABLA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@cedis IS NULL OR cedis = @cedis)
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


def cobertura() -> dict[str, dict]:
    """Rango de fechas con datos de cada fase. Ver punto 3 del docstring."""
    filas = run_query(_COBERTURA_SQL, "la cobertura del flujo de producto")
    return {
        fila["fase"]: {"desde": _iso(fila["desde"]), "hasta": _iso(fila["hasta"])}
        for fila in filas
    }


def _acumular(destino: dict, clave, fila: dict) -> None:
    acumulado = destino[clave]
    acumulado["num_lineas"] += fila["num_lineas"] or 0
    acumulado["monto_total"] += fila["monto_total"] or 0.0
    # Solo facturado trae cajas; en las otras fases se queda en None en vez de 0
    # para que la interfaz distinga "cero cajas" de "aquí no aplica".
    if fila["cantidad_cajas_total"] is not None:
        actual = acumulado["cantidad_cajas_total"] or 0.0
        acumulado["cantidad_cajas_total"] = actual + fila["cantidad_cajas_total"]


def _nuevo() -> dict:
    return {"num_lineas": 0, "monto_total": 0.0, "cantidad_cajas_total": None}


def build_flujo(
    *,
    division: str | None,
    cedis: str | None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/flujo.

    Una sola consulta al detalle diario y las agregaciones en memoria: la tabla
    gold entera son 4,7 MB, así que traer el trozo filtrado y agrupar aquí sale
    más barato que lanzar tres consultas.
    """
    filas = run_query(
        _DETALLE_SQL,
        "el flujo de producto",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "cedis": ("STRING", cedis),
        },
    )

    por_fase: dict = defaultdict(_nuevo)
    por_fecha: dict = defaultdict(_nuevo)
    por_cedis: dict = defaultdict(_nuevo)
    # `cantidad` NO se suma entre unidades (punto 1 del docstring): la clave
    # lleva la unidad dentro, y quien la pinte tiene que respetar ese desglose.
    por_unidad: dict = defaultdict(float)

    for fila in filas:
        fase = fila["fase"]
        _acumular(por_fase, fase, fila)
        _acumular(por_fecha, (_iso(fila["fecha"]), fase), fila)
        _acumular(por_cedis, (fila["cedis"], fase), fila)
        if fila["unidad"] and fila["cantidad_total"]:
            por_unidad[(fase, fila["unidad"])] += fila["cantidad_total"]

    return {
        "cobertura": cobertura(),
        "resumen": [{"fase": fase, **datos} for fase, datos in sorted(por_fase.items())],
        "por_fecha": [
            {"fecha": fecha, "fase": fase, **datos}
            for (fecha, fase), datos in sorted(por_fecha.items())
        ],
        "por_cedis": [
            {"cedis": cedis_nombre, "fase": fase, **datos}
            for (cedis_nombre, fase), datos in sorted(
                por_cedis.items(), key=lambda item: (item[0][0] or "", item[0][1])
            )
        ],
        "cantidad_por_unidad": [
            {"fase": fase, "unidad": unidad, "cantidad_total": total}
            for (fase, unidad), total in sorted(por_unidad.items())
        ],
    }
