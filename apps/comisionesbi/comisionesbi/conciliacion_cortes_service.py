"""Conciliación por cortes — capa de datos: lee BigQuery, llama al motor y serializa.

El motor (`conciliacion_cortes_engine`) no sabe de bases de datos; aquí se le
alimentan los pagos por documento (`DBC_gold_conciliacion_pago_documento`) y los
cobros diarios (`DBC_gold_conciliacion_producto_diario`, la misma que lee la
pestaña de conciliación vigente), y se devuelve JSON.

Fase 3 (solo lectura): todavía no hay estado del usuario, así que todas las
ventanas son las que propone el texto del pago. Cuando exista Firestore, el
estado de cada fila (`EstadoFila`) entra a `construir_filas` desde `_cargar`.

Rango que se carga: el mes pedido más 35 días a cada lado. Los pagos que se
devuelven son los que tocan el mes; el margen es para que el motor conozca a sus
vecinos (necesita al pago anterior y al siguiente para sugerir un corte).
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from comisionesbi.conciliacion_cortes_engine import (
    SIN_VENTANA,
    DocPago,
    FilaKey,
    FilaResuelta,
    PagoResuelto,
    Sugerencia,
    construir_filas,
)
from comisionesbi.conciliacion_engine import cobertura
from comisionesbi.db import run_query

_TABLA_PAGO_DOC = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_pago_documento`"
_TABLA_DIARIA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`"
_TABLA_VENDORS = "`proan-quantrue.D20_DIMENSION.dm_vendors`"

MARGEN_DIAS = 35
# Un pago sin ventana legible no tiene fechas que lo ubiquen en un mes: se asigna al
# mes en que se pagó (y a las dos semanas siguientes, que es cuando se paga el cierre).
GRACIA_SIN_VENTANA_DIAS = 14

_MES = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

_DOCS_SQL = f"""
SELECT d.sociedad, d.doc_id, d.comisionista_id, d.division_code, d.desde_texto, d.hasta_texto,
       d.ventana_valida, d.pagado, d.fecha_pago, v.razon_social AS comisionista
FROM {_TABLA_PAGO_DOC} d
LEFT JOIN (
  SELECT id_proveedor, ANY_VALUE(razon_social) AS razon_social FROM {_TABLA_VENDORS} GROUP BY id_proveedor
) v ON v.id_proveedor = d.comisionista_id
WHERE (@sociedad IS NULL OR d.sociedad = @sociedad)
  AND (@division IS NULL OR d.division_code = @division)
  AND (@comisionista_id IS NULL OR d.comisionista_id = @comisionista_id)
  AND (
    (d.ventana_valida AND d.desde_texto <= @fin_ext AND d.hasta_texto >= @ini_ext)
    OR (NOT d.ventana_valida AND d.fecha_pago BETWEEN @ini AND @fin_pago)
  )
"""

_DIARIO_SQL = f"""
SELECT sociedad, comisionista_id, division_code, fecha, SUM(comision_total) AS comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini_ext AND @fin_ext
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY sociedad, comisionista_id, division_code, fecha
"""

_DETALLE_SQL = f"""
SELECT cedis, oficina, tipo_venta, matnr, descripcion, unidad_venta, unidad_tarifa,
  ANY_VALUE(tarifa)           AS tarifa,
  SUM(num_lineas)             AS num_lineas,
  SUM(cantidad_venta_total)   AS cantidad_venta_total,
  SUM(monto_total)            AS monto_total,
  SUM(cantidad_base_total)    AS cantidad_base_total,
  SUM(comision_total)         AS comision_total,
  SUM(lineas_sin_comision)    AS lineas_sin_comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini AND @fin
  AND sociedad = @sociedad
  AND comisionista_id = @comisionista_id
  AND (@division IS NULL OR division_code = @division)
GROUP BY cedis, oficina, tipo_venta, matnr, descripcion, unidad_venta, unidad_tarifa
"""


def rango_mes(mes: str) -> tuple[date, date]:
    m = _MES.match(mes)
    if not m:
        raise ValueError("mes debe tener el formato AAAA-MM.")
    ini = date(int(m.group(1)), int(m.group(2)), 1)
    siguiente = date(ini.year + (ini.month == 12), ini.month % 12 + 1, 1)
    return ini, siguiente - timedelta(days=1)


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


# ─── Carga ───────────────────────────────────────────────────────────────


def _cargar(mes: str, sociedad, division, comisionista_id, con_cobertura: bool = False):
    ini, fin = rango_mes(mes)
    params = {
        "ini": ("DATE", ini),
        "fin_pago": ("DATE", fin + timedelta(days=GRACIA_SIN_VENTANA_DIAS)),
        "ini_ext": ("DATE", ini - timedelta(days=MARGEN_DIAS)),
        "fin_ext": ("DATE", fin + timedelta(days=MARGEN_DIAS)),
        "sociedad": ("STRING", sociedad),
        "division": ("STRING", division),
        "comisionista_id": ("STRING", comisionista_id),
    }
    # Las consultas son independientes: en paralelo, la espera es la de la más lenta.
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_docs = pool.submit(run_query, _DOCS_SQL, "los pagos por documento", params)
        f_diario = pool.submit(
            run_query,
            _DIARIO_SQL,
            "los cobros diarios por comisionista",
            {k: v for k, v in params.items() if k not in ("ini", "fin_pago")},
        )
        f_cobertura = pool.submit(cobertura) if con_cobertura else None
        filas_docs, filas_diario = f_docs.result(), f_diario.result()
        cobertura_datos = f_cobertura.result() if f_cobertura else None
    nombres = {r["comisionista_id"]: r.get("comisionista") for r in filas_docs}
    docs = [DocPago.desde_fila(r) for r in filas_docs]
    diario = [
        {
            "sociedad": r["sociedad"],
            "comisionista_id": r["comisionista_id"],
            "division_code": r["division_code"],
            "fecha": r["fecha"],
            "comision": float(r["comision"] or 0.0),
        }
        for r in filas_diario
    ]
    # Fase 4: aquí entran los `EstadoFila` guardados en Firestore (tercer argumento).
    resueltas = construir_filas(docs, diario, None, (ini, fin))
    return ini, fin, resueltas, nombres, diario, cobertura_datos


# ─── Serialización ───────────────────────────────────────────────────────


def _sugerencia_json(s: Sugerencia | None) -> dict | None:
    if s is None:
        return None
    return {
        "tipo": s.tipo,
        "pago_id": s.pago_id,
        "unica": s.unica,
        "n_opciones": s.n_opciones,
        "cambios": [
            {"pago_id": c.pago_id, "borde": c.borde, "de": _iso(c.de), "a": _iso(c.a)} for c in s.cambios
        ],
        "afectados": [
            {
                "pago_id": a.pago_id,
                "ini_antes": _iso(a.ini_antes),
                "fin_antes": _iso(a.fin_antes),
                "ini_despues": _iso(a.ini_despues),
                "fin_despues": _iso(a.fin_despues),
                "diferencia_antes": a.diferencia_antes,
                "diferencia_despues": a.diferencia_despues,
            }
            for a in s.afectados
        ],
    }


def _pago_json(p: PagoResuelto) -> dict:
    return {
        "pago_id": p.pago_id,
        "docs": list(p.docs),
        "ini": _iso(p.ini),
        "fin": _iso(p.fin),
        "ini_default": _iso(p.ini_default),
        "fin_default": _iso(p.fin_default),
        "pagado": p.pagado,
        "calculado": p.calculado,
        "diferencia": p.diferencia,
        "estado": p.estado,
        "sin_calculo": p.sin_calculo,
        "drift": p.drift,
        "ajustado": p.ajustado,
        "sugerencia": _sugerencia_json(p.sugerencia),
    }


def _fila_json(fila: FilaResuelta, nombre: str | None, pagos: list[PagoResuelto]) -> dict:
    sociedad, comisionista_id, division_code = fila.key
    return {
        "fila_id": f"{sociedad}|{comisionista_id}|{division_code or ''}",
        "sociedad": sociedad,
        "comisionista_id": comisionista_id,
        "comisionista": nombre,
        "division_code": division_code,
        "pagos": [_pago_json(p) for p in pagos],
        "huecos": [
            {"ini": _iso(h.ini), "fin": _iso(h.fin), "comision": h.comision, "despues_de": h.despues_de, "antes_de": h.antes_de}
            for h in fila.huecos
        ],
        "traslapes": [{"ini": _iso(t.ini), "fin": _iso(t.fin), "pagos": list(t.pagos)} for t in fila.traslapes],
        "cortes": [
            {"izq": c.izq, "der": c.der, "fecha": _iso(c.fecha), "congelado": c.congelado} for c in fila.cortes
        ],
    }


def _toca_el_mes(p: PagoResuelto, ini: date, fin: date) -> bool:
    return p.estado == SIN_VENTANA or (p.ini is not None and p.ini <= fin and p.fin >= ini)


# ─── Puntos de entrada ───────────────────────────────────────────────────


def build_mes(*, mes: str, sociedad=None, division=None, comisionista_id=None) -> dict:
    """La lista del mes: una fila por sociedad × comisionista × división, con los pagos que tocan el mes."""
    ini, fin, filas, nombres, _, cobertura_datos = _cargar(mes, sociedad, division, comisionista_id, con_cobertura=True)
    salida = []
    for key, fila in filas.items():
        pagos = [p for p in fila.pagos if _toca_el_mes(p, ini, fin)]
        if pagos:
            salida.append(_fila_json(fila, nombres.get(key[1]), pagos))
    salida.sort(key=lambda f: (f["comisionista"] is None, f["comisionista"] or f["comisionista_id"], f["division_code"] or ""))
    return {
        "mes": mes,
        "desde": ini.isoformat(),
        "hasta": fin.isoformat(),
        "cobertura": cobertura_datos,
        "filas": salida,
    }


def build_fila(*, mes: str, sociedad: str, comisionista_id: str, division_code: str | None) -> dict:
    """El panel de una fila: todos sus pagos del rango cargado y los cobros diarios para dibujar la línea de tiempo."""
    ini, fin, filas, nombres, diario, _ = _cargar(mes, sociedad, division_code, comisionista_id)
    key = (sociedad, comisionista_id, division_code)
    fila = filas.get(key)
    if fila is None:
        return {"mes": mes, "fila": None, "dias": []}
    dias = sorted(
        ([_iso(r["fecha"]), r["comision"]] for r in diario
         if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key),
        key=lambda x: x[0],
    )
    return {"mes": mes, "fila": _fila_json(fila, nombres.get(comisionista_id), fila.pagos), "dias": dias}


def build_detalle(
    *, sociedad: str, comisionista_id: str, division_code: str | None, ini: date, fin: date
) -> dict:
    """Detalle por producto de la ventana de un pago (misma forma que el de la pestaña vigente, sin periodo)."""
    filas = run_query(
        _DETALLE_SQL,
        "el detalle por producto de la ventana",
        {
            "ini": ("DATE", ini),
            "fin": ("DATE", fin),
            "sociedad": ("STRING", sociedad),
            "comisionista_id": ("STRING", comisionista_id),
            "division": ("STRING", division_code),
        },
    )
    filas = [{k: (float(v) if hasattr(v, "as_tuple") else v) for k, v in f.items()} for f in filas]
    filas.sort(key=lambda f: (f["cedis"] is None, f["cedis"] or "", f["oficina"] or "", -(f["cantidad_venta_total"] or 0)))
    return {
        "ini": ini.isoformat(),
        "fin": fin.isoformat(),
        "filas": filas,
        "comision_total": sum(f["comision_total"] or 0.0 for f in filas),
    }
