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
2. `cantidad_cajas` ya existe en las tres fases, pero NO es "cajas": es la
   cantidad en la unidad base del material (PAQ, CS, PZA, SAC...), que es la
   única comparable entre unidades. El nombre se mantuvo porque es el que ya
   consumía el dashboard. Sigue pudiendo ser NULL —"aquí no aplica"— y por eso
   no se convierte en cero al agregar.
3. Cada fase tiene su propia fecha de corte y no tienen por qué coincidir:
   "vendido" sale de `sap_VBAP`, cuya carga se ha quedado atrás más de una vez
   (ver data/notas/hallazgos.md). Aquí no se escribe ninguna fecha concreta
   porque envejece mal: la de verdad la devuelve `cobertura`, y por eso este
   módulo la devuelve siempre. Sin ese dato, la pantalla dibujaría ceros donde
   lo que falta es el dato, y parecería un desplome de ventas en vez de una
   laguna.

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
  AND (@tipo_venta IS NULL OR tipo_venta = @tipo_venta)
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
    # Las cajas ya vienen en las tres fases, pero el None se respeta igual: si
    # una fase no trae el dato se queda en None en vez de 0, para que la interfaz
    # distinga "cero cajas" de "aquí no aplica".
    if fila["cantidad_cajas_total"] is not None:
        actual = acumulado["cantidad_cajas_total"] or 0.0
        acumulado["cantidad_cajas_total"] = actual + fila["cantidad_cajas_total"]


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


def build_flujo(
    *,
    division: str | None,
    cedis: str | None,
    tipo_venta: str | None = None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/flujo.

    Una sola consulta al detalle diario y las agregaciones en memoria: la tabla
    gold entera son 4,7 MB, así que traer el trozo filtrado y agrupar aquí sale
    más barato que lanzar una consulta por agrupación.

    Se devuelven las agrupaciones por CEDIS, división y tipo de venta porque la
    pantalla deja pulsar sobre ellas para filtrar el resto; el nombre de la
    división viaja junto a su código para que la interfaz pueda enseñar "Huevo"
    y filtrar por "H" sin tener que cruzar nada.
    """
    filas = run_query(
        _DETALLE_SQL,
        "el flujo de producto",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "cedis": ("STRING", cedis),
            "tipo_venta": ("STRING", tipo_venta),
        },
    )

    por_fase: dict = defaultdict(_nuevo)
    por_fecha: dict = defaultdict(_nuevo)
    por_cedis: dict = defaultdict(_nuevo)
    por_division: dict = defaultdict(_nuevo)
    por_tipo_venta: dict = defaultdict(_nuevo)
    nombre_division: dict = {}
    # `cantidad` NO se suma entre unidades (punto 1 del docstring): la clave
    # lleva la unidad dentro, y quien la pinte tiene que respetar ese desglose.
    por_unidad: dict = defaultdict(float)

    for fila in filas:
        fase = fila["fase"]
        _acumular(por_fase, fase, fila)
        _acumular(por_fecha, (_iso(fila["fecha"]), fase), fila)
        _acumular(por_cedis, (fila["cedis"], fase), fila)
        _acumular(por_division, (fila["division_code"], fase), fila)
        _acumular(por_tipo_venta, (fila["tipo_venta"], fase), fila)
        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]
        if fila["unidad"] and fila["cantidad_total"]:
            por_unidad[(fase, fila["unidad"])] += fila["cantidad_total"]

    divisiones = _ordenadas(por_division, "division_code")
    for entrada in divisiones:
        entrada["division"] = nombre_division.get(entrada["division_code"])

    return {
        "cobertura": cobertura(),
        "resumen": [{"fase": fase, **datos} for fase, datos in sorted(por_fase.items())],
        "por_fecha": [
            {"fecha": fecha, "fase": fase, **datos}
            for (fecha, fase), datos in sorted(por_fecha.items())
        ],
        "por_cedis": _ordenadas(por_cedis, "cedis"),
        "por_division": divisiones,
        "por_tipo_venta": _ordenadas(por_tipo_venta, "tipo_venta"),
        "cantidad_por_unidad": [
            {"fase": fase, "unidad": unidad, "cantidad_total": total}
            for (fase, unidad), total in sorted(por_unidad.items())
        ],
    }
