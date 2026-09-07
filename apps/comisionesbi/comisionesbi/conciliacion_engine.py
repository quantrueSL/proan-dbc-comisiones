"""Módulo 3 · Conciliación por comisionista — el detalle que hoy se arma a mano.

Quien concilia hace esto cada semana (sábado a viernes, se paga el viernes
siguiente): ve la factura del comisionista, ve qué vendió esa semana, escribe
los productos uno por uno con su tarifa y cantidad, multiplica, y compara el
total contra lo que le pagaron. Este módulo no reemplaza ese último paso —
sigue sin existir una fuente en BigQuery que diga cuánto se le pagó de verdad a
cada comisionista (ver `Datos/Comisiones_DBC_Borrador_Tecnico.md`, sección
16.3: se probaron seis vías distintas para bajar del pago agregado en BSIK al
detalle, ninguna llega) — pero sí arma automáticamente todo lo anterior.

Lee `ZZ_PRUEBAS.DBC_gold_conciliacion_producto_semanal`
(`Datos/sql/v1_conciliacion_producto_semanal.sql`), agregada por PERIODO DE
PAGO (no siempre 7 días, ver ese archivo) × comisionista × CEDIS × oficina ×
tipo de venta × producto — el mismo grano que ella escribe en su hoja.
`detalle_diario()` lee la tabla diaria de la que sale esa agregación
(`DBC_gold_conciliacion_producto_diario`), para la pestaña de detalle día por
día del Excel exportado. `detalle_factura()` baja un nivel más, a la línea de
factura real (`DBC_gold_conciliacion_factura_linea`, la base de la que salen
diario y semanal) — trae también cobro por línea, la única excepción a "en
pausa perseguir cobro": cuando se pueda calcular comisión sobre lo cobrado,
sale de esta tabla.

PENDIENTE, a propósito, no resuelto aquí:
  - El corte de periodo en fin de mes (2026-09-02) es un supuesto de Silvana
    sin confirmar con el cliente -- ver la cabecera de
    `v1_conciliacion_producto_semanal.sql`. Por eso existe el detalle diario:
    para poder verificar o ajustar a mano si un caso concreto no encaja.
  - `unidad_venta`/`unidad_tarifa` confirmadas 2026-09-07 con la distribución
    real de `sales_unit` por división (monto DBC 2026): H 99.97% CS -> caja;
    IA ~100% SAC -> saco; BO 99.4% PAQ -> paquete; A y L 100% PZA -> pieza.
    `unidad_tarifa` (antes `base_unidad`) es kg en H/IA (peso real) e igual a
    `unidad_venta` en BO/A/L (no hay conversión real ahí, es la misma
    cantidad). Ya no es un supuesto pendiente.
  - `comisionista` sigue en NULL donde ninguna fuente trae su nombre — esas
    líneas se agrupan bajo `None`, no desaparecen.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from comisionesbi.db import run_query

_TABLA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_semanal`"
_TABLA_DIARIA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`"
_TABLA_FACTURA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_factura_linea`"

_DETALLE_SQL = f"""
SELECT
  semana, periodo_fin, division_code, division, cedis, oficina, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, unidad_tarifa, tarifa,
  num_lineas, cantidad_venta_total, monto_total, cantidad_base_total,
  comision_total, lineas_sin_comision
FROM {_TABLA}
WHERE semana BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista IS NULL OR comisionista = @comisionista)
"""

# Mismas columnas que `_DETALLE_SQL` pero por día (`fecha`), no por periodo de
# pago -- la transparencia que pidió Silvana para el borde de mes: el periodo
# agregado es un supuesto (ver v1_conciliacion_producto_semanal.sql), así que
# el Excel también trae el desglose día por día para que se pueda verificar o
# ajustar a mano si el supuesto no encaja con un caso concreto.
_DETALLE_DIARIO_SQL = f"""
SELECT
  fecha, division_code, division, cedis, oficina, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, unidad_tarifa, tarifa,
  num_lineas, cantidad_venta_total, monto_total, cantidad_base_total,
  comision_total, lineas_sin_comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista IS NULL OR comisionista = @comisionista)
"""

# Grano línea de factura -- la hoja de máximo detalle del Excel: de la
# comisión calculada a la factura exacta que la compone. Incluye cobro
# (se_cobro/monto_cobrado/comision_cobrada), a diferencia de las otras dos: es
# la excepción a propósito a "en pausa perseguir cobro" (2026-09-02) porque
# cuando se pueda calcular la comisión sobre lo cobrado, sale de aquí.
_DETALLE_FACTURA_SQL = f"""
SELECT
  billing_document, item_number, fecha, division_code, division, cedis,
  oficina, comisionista, tipo_venta, matnr, descripcion, unidad_venta,
  cantidad_venta, unidad_tarifa, cantidad_base, tarifa, monto, comision,
  comision_estado, se_cobro, monto_cobrado, cantidad_cobrada,
  comision_cobrada, fecha_cobro
FROM {_TABLA_FACTURA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista IS NULL OR comisionista = @comisionista)
"""

# Sin filtro de fechas a propósito, igual que en flujo/comisiones: "hasta
# cuándo hay datos" es una propiedad del dataset, no del rango pedido.
_COBERTURA_SQL = f"SELECT MIN(semana) AS desde, MAX(semana) AS hasta FROM {_TABLA}"


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


def cobertura() -> dict:
    filas = run_query(_COBERTURA_SQL, "la cobertura de conciliación")
    if not filas:
        return {}
    return {"desde": _iso(filas[0]["desde"]), "hasta": _iso(filas[0]["hasta"])}


def _nuevo_comisionista() -> dict:
    return {
        "num_lineas": 0,
        "monto_total": 0.0,
        "comision_total": 0.0,
        "lineas_sin_comision": 0,
        "semanas": set(),
    }


def build_conciliacion(
    *,
    division: str | None,
    comisionista: str | None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion.

    `por_comisionista` es el nivel 1 de la pantalla (a quién hay que pagarle
    esta semana). `detalle` trae cada fila tal cual sale de la tabla gold —ya
    al grano de producto— para que la pantalla arme la cascada CEDIS → oficina
    → tipo de venta → producto agrupando en memoria: filtrado a un comisionista
    y unas semanas, son decenas de filas, no miles, así que no hace falta que
    el backend pre-agregue cada nivel como sí hace `comisiones_engine`.
    """
    filas = run_query(
        _DETALLE_SQL,
        "la conciliación por comisionista",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista": ("STRING", comisionista),
        },
    )

    por_comisionista: dict = defaultdict(_nuevo_comisionista)
    nombre_division: dict = {}

    for fila in filas:
        clave = (fila["comisionista"], fila["division_code"])
        c = por_comisionista[clave]
        c["num_lineas"] += fila["num_lineas"] or 0
        c["monto_total"] += fila["monto_total"] or 0.0
        c["comision_total"] += fila["comision_total"] or 0.0
        c["lineas_sin_comision"] += fila["lineas_sin_comision"] or 0
        c["semanas"].add(fila["semana"])
        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]

    filas_comisionista = [
        {
            "comisionista": comisionista_,
            "division_code": division_code,
            "division": nombre_division.get(division_code),
            "num_lineas": datos["num_lineas"],
            "monto_total": datos["monto_total"],
            "comision_total": datos["comision_total"],
            "lineas_sin_comision": datos["lineas_sin_comision"],
            "num_semanas": len(datos["semanas"]),
        }
        for (comisionista_, division_code), datos in por_comisionista.items()
    ]
    # Alfabético por comisionista y luego división -- a diferencia de
    # comisiones_engine, aquí lo que se busca es a una persona concreta en la
    # lista (para cuadrar contra su factura), no quién se lleva más. Nulos al
    # final, igual que en el resto de la pantalla.
    filas_comisionista.sort(
        key=lambda f: (f["comisionista"] is None, f["comisionista"] or "", f["division_code"] or "")
    )

    return {
        "cobertura": cobertura(),
        "por_comisionista": filas_comisionista,
        "detalle": [
            {**fila, "semana": _iso(fila["semana"]), "periodo_fin": _iso(fila["periodo_fin"])} for fila in filas
        ],
    }


def detalle_diario(
    *,
    division: str | None,
    comisionista: str | None,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion/diario.

    Se pide aparte y no dentro de `build_conciliacion`: esa respuesta ya trae
    el detalle de TODOS los comisionistas del rango para armar la tabla
    maestra, y el diario solo hace falta al exportar UNO -- pedirlo siempre
    multiplicaría el tamaño de cada carga de pantalla por días en vez de por
    periodos, sin que nadie lo use casi nunca.
    """
    filas = run_query(
        _DETALLE_DIARIO_SQL,
        "el detalle diario de conciliación",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista": ("STRING", comisionista),
        },
    )
    return [{**fila, "fecha": _iso(fila["fecha"])} for fila in filas]


def detalle_factura(
    *,
    division: str | None,
    comisionista: str | None,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion/factura.

    Un renglón por línea de factura real (billing_document + item_number) —
    el nivel de trazabilidad máximo: de la comisión calculada a la factura
    exacta que la compone. Se pide aparte por el mismo motivo que
    `detalle_diario`: solo hace falta al exportar un comisionista, no en cada
    carga de pantalla.
    """
    filas = run_query(
        _DETALLE_FACTURA_SQL,
        "el detalle de factura de conciliación",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista": ("STRING", comisionista),
        },
    )
    return [
        {**fila, "fecha": _iso(fila["fecha"]), "fecha_cobro": _iso(fila["fecha_cobro"])} for fila in filas
    ]
