"""Módulo 1 · Comisión — cuánto se ha devengado, y qué falta para el resto.

Lee `ZZ_PRUEBAS.DBC_gold_comision_diaria`, que construye
`data/consultas/DBC_gold_comision_diaria.sql` a partir de la vista
`v1_comision_linea` (definida en `Datos/sql/v1_comision_dbc.sql`). No se
consulta la vista directamente porque cada consulta escanea 0,53 GiB: filtrar en
pantalla sobre eso sería pagar medio giga por clic. La tabla gold son ~12 MB.

ESTE MÓDULO DEVUELVE UN NÚMERO INCOMPLETO, Y ESO NO ES UN FALLO
Hoy alrededor del 58% del facturado en alcance llega a tener tarifa aplicable.
El resto está bloqueado por cosas concretas que el cliente tiene que contestar,
y la mayor con diferencia es cuál de sus dos hojas de tarifas de botana está
vigente: son $174 M de facturado cuya comisión está entre $13,7 M y $20,2 M. La
respuesta trae por eso dos bloques que hay que leer juntos:

  `totales`   lo devengado, y sobre cuánto facturado se ha podido calcular.
  `bloqueado` por qué el resto no entra, cuánto factura cada motivo, y cuánto
              valdría si entrara.

Enseñar el total sin el segundo bloque sería exactamente cómo se construye una
cifra que nadie puede cuadrar seis meses después. La pantalla los enseña juntos
y el motor los devuelve juntos: no hay forma de pedir uno sin el otro.

TRES COSAS QUE NO SON EVIDENTES:

1. LA COMISIÓN SE CALCULA SOBRE LO FACTURADO, aunque se pague sobre lo cobrado.
   No es una decisión de diseño sino de datos: `sap_pago` da una fila por
   factura, sin material, así que sobre lo cobrado no hay SET y no hay tarifa
   posible. Además esa fuente solo ve el 27% del importe facturado, con un
   ratio plano en los ocho meses de 2026 — si fuera retraso de cobro, enero
   estaría muy por encima de agosto, y está igual. Por eso `comision_con_cobro`
   se devuelve aparte y NO se llama "pagable": es el suelo conocido.

2. `cantidad_base` MEZCLA KILOS Y CAJAS si se suma entre divisiones. Huevo se
   comisiona por kilo y el resto por caja (ver `dim_base_comision_v1`), así que
   la cantidad viaja siempre desglosada por `base_unidad` y nunca como un total
   único. El importe y la comisión sí se suman: son pesos.

3. LO QUE ESTÁ EN CONFLICTO NO SE INVENTA. Donde las dos hojas de tarifas del
   cliente se contradicen, la comisión es NULL y en su lugar viaja una horquilla
   (`comision_min`/`comision_max`). Botana tiene 619 llaves así.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from comisionesbi.db import run_query

_TABLA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_comision_diaria`"

# Mismo patrón que flujo_engine: `(@x IS NULL OR columna = @x)` para que un solo
# SQL sirva a todas las combinaciones de filtro sin construir la cadena a trozos.
_DETALLE_SQL = f"""
SELECT
  fecha, division_code, division, cedis, oficina, comisionista,
  tipo_venta, `set`, base_unidad, comision_estado,
  num_lineas, monto_total, cantidad_base_total,
  comision_total, comision_min_total, comision_max_total,
  comision_cobrada, monto_cobrado, lineas_sin_importe
FROM {_TABLA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@cedis IS NULL OR cedis = @cedis)
  AND (@comisionista IS NULL OR comisionista = @comisionista)
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
    }


def _acumular(destino: dict, clave, fila: dict) -> None:
    a = destino[clave]
    a["num_lineas"] += fila["num_lineas"] or 0
    a["monto"] += fila["monto_total"] or 0.0
    a["comision"] += fila["comision_total"] or 0.0
    a["comision_con_cobro"] += fila["comision_cobrada"] or 0.0
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


def build_report(
    *,
    division: str | None,
    cedis: str | None,
    comisionista: str | None = None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/report.

    Una sola consulta y las agregaciones en memoria, igual que en el flujo: la
    tabla gold entera son ~12 MB, así que traer el trozo filtrado y agrupar aquí
    sale más barato que lanzar una consulta por agrupación.
    """
    filas = run_query(
        _DETALLE_SQL,
        "el informe de comisión",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "cedis": ("STRING", cedis),
            "comisionista": ("STRING", comisionista),
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
    }
