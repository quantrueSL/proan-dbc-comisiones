"""Conciliación por cortes — capa de datos: lee BigQuery, llama al motor y serializa.

El motor (`conciliacion_cortes_engine`) no sabe de bases de datos; aquí se le
alimentan los pagos por documento (`DBC_gold_conciliacion_pago_documento`) y los
cobros diarios (`DBC_gold_conciliacion_producto_diario`, la misma que lee la
pestaña de conciliación vigente), y se devuelve JSON.

Lo calculado y lo pagado vienen de BigQuery (con una caché corta de las filas
crudas, para que editar no vuelva a consultar); las decisiones del usuario
(ventanas ajustadas, sugerencias descartadas) vienen de Firestore y se
aplican encima con `EstadoFila`. Toda escritura repite la resolución con los
mismos datos y devuelve la fila ya actualizada.

Rango que se carga: el mes pedido más 35 días a cada lado. Los pagos que se
devuelven son los que tocan el mes; el margen es para que el motor conozca a sus
vecinos (necesita al pago anterior y al siguiente para sugerir un corte).
"""

from __future__ import annotations

import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from comisionesbi.conciliacion_cortes_engine import (
    CONSOLIDADO,
    OK,
    SIN_VENTANA,
    CambioBorde,
    DocPago,
    ErrorCorte,
    FilaKey,
    FilaResuelta,
    PagoResuelto,
    SerieDiaria,
    Sugerencia,
    agrupar_pagos,
    construir_filas,
    resolver_fila,
    ultimos_dias_con_cobros,
)
from comisionesbi.conciliacion_cortes_estado import (
    ConflictoVersion,
    DocFila,
    ahora_iso,
    get_store,
)
from comisionesbi.conciliacion_engine import cobertura
from comisionesbi.db import run_query

_TABLA_PAGO_DOC = "`proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento`"
_TABLA_DIARIA = "`proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`"
_TABLA_VENDORS = "`proan-quantrue.D20_DIMENSION.dm_vendors`"

# Divisiones que se pagan en el mismo documento que otra: el pago de Huevo de DBC cubre también Abarrotes
# (confirmado con el cliente; con Abarrotes sumado cuadran 339 de 807 pagos en vez de 192). Se calcula en bloque.
DIVISIONES_JUNTAS: dict[tuple[str, str], tuple[str, ...]] = {("DBC", "H"): ("A",)}
_JUNTA_A_PAGO = {(soc, otra): div for (soc, div), otras in DIVISIONES_JUNTAS.items() for otra in otras}

MARGEN_DIAS = 35
# Un pago sin ventana legible no tiene fechas que lo ubiquen en un mes: se asigna al
# mes en que se pagó (y a las dos semanas siguientes, que es cuando se paga el cierre).
GRACIA_SIN_VENTANA_DIAS = 14

_MES = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

_DOCS_SQL = f"""
SELECT d.sociedad, d.doc_id, d.comisionista_id, d.division_code, d.desde_texto, d.hasta_texto,
       d.ventana_valida, d.pagado, d.fecha_pago, d.augbl, d.texto, v.razon_social AS comisionista
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

# `division_pago` es la división con la que se paga: Abarrotes de DBC se cobra junto con Huevo.
_DIVISION_PAGO_SQL = "IF(sociedad = 'DBC' AND division_code = 'A', 'H', division_code)"

_DIARIO_SQL = f"""
SELECT sociedad, comisionista_id, {_DIVISION_PAGO_SQL} AS division_code, division_code AS origen,
       fecha, SUM(comision_total) AS comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini_ext AND @fin_ext
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY 1, 2, 3, 4, 5
"""

# Total de comisión por día de todos los comisionistas: de ahí sale el último día con cobros de cada mes.
_CIERRES_SQL = f"""
SELECT fecha, SUM(comision_total) AS comision
FROM {_TABLA_DIARIA}
WHERE fecha >= DATE '2025-01-01'
GROUP BY fecha
HAVING SUM(comision_total) > 0
"""

_DETALLE_SQL = f"""
SELECT division_code, cedis, oficina, tipo_venta, matnr, descripcion, unidad_venta, unidad_tarifa,
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
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
GROUP BY division_code, cedis, oficina, tipo_venta, matnr, descripcion, unidad_venta, unidad_tarifa
"""


# Detalle de un pago para el Excel: mismas columnas que la pestaña vigente, con Abarrotes de DBC dentro de Huevo.
_TABLA_FACTURA = "`proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_factura_linea`"

_DIARIO_PAGO_SQL = f"""
SELECT fecha, sociedad, division_code, division, cedis, oficina, comisionista_id, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, unidad_tarifa, tarifa,
  num_lineas, cantidad_venta_total, monto_total, cantidad_base_total, comision_total, lineas_sin_comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini AND @fin
  AND sociedad = @sociedad
  AND comisionista_id = @comisionista_id
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
"""

_FACTURA_PAGO_SQL = f"""
SELECT billing_document, item_number, fecha, sociedad, division_code, division, cedis,
  oficina, comisionista_id, comisionista, tipo_venta, matnr, descripcion, unidad_venta,
  cantidad_venta, unidad_tarifa, cantidad_base, tarifa, monto, comision,
  comision_estado, se_cobro, monto_cobrado, cantidad_cobrada, comision_cobrada, fecha_cobro
FROM {_TABLA_FACTURA}
WHERE fecha_cobro BETWEEN @ini AND @fin
  AND sociedad = @sociedad
  AND comisionista_id = @comisionista_id
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
"""


def rango_mes(mes: str) -> tuple[date, date]:
    m = _MES.match(mes)
    if not m:
        raise ValueError("mes debe tener el formato AAAA-MM.")
    ini = date(int(m.group(1)), int(m.group(2)), 1)
    siguiente = date(ini.year + (ini.month == 12), ini.month % 12 + 1, 1)
    return ini, siguiente - timedelta(days=1)


def rango_de(periodo) -> tuple[date, date]:
    """El rango que se pide: un mes `AAAA-MM` o ya un par (desde, hasta), como el de las semanas que se ven en pantalla."""
    return rango_mes(periodo) if isinstance(periodo, str) else periodo


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


# ─── Carga ───────────────────────────────────────────────────────────────


_CACHE_TTL_POR_DEFECTO = 120
# (mes, sociedad, división, comisionista, cobertura) -> (vence, datos crudos). Solo lo que viene de BigQuery.
_CACHE: dict[tuple, tuple[float, tuple]] = {}


_CIERRES_CACHE: list = []  # [(vence, frozenset de días)]


def _cierres() -> frozenset:
    """El último día con cobros de cada mes cerrado, con todos los comisionistas juntos (igual para todas las filas)."""
    ttl = _cache_ttl_seconds()
    if ttl and _CIERRES_CACHE and _CIERRES_CACHE[0][0] > time.monotonic():
        return _CIERRES_CACHE[0][1]
    filas = run_query(_CIERRES_SQL, "los días de cierre de mes", {})
    dias = ultimos_dias_con_cobros({r["fecha"]: float(r["comision"] or 0.0) for r in filas})
    if ttl:
        _CIERRES_CACHE[:] = [(time.monotonic() + max(ttl, 3600), dias)]
    return dias


def _cache_ttl_seconds() -> int:
    try:
        return max(int(os.getenv("CORTES_CACHE_TTL_SECONDS", "")), 0)
    except ValueError:
        return _CACHE_TTL_POR_DEFECTO


def _datos(mes: "str | tuple[date, date]", sociedad, division, comisionista_id, con_cobertura: bool = False):
    """Lo crudo de BigQuery: (ini, fin, docs, diario, nombres, cobertura, partes, info_docs).

    `diario` ya suma las divisiones que se pagan juntas; `partes` guarda cada origen por separado
    ({fila: {división de origen: {fecha: comisión}}}) para enseñar de dónde viene el calculado.
    """
    llave = (mes, sociedad, division, comisionista_id, con_cobertura)
    ttl = _cache_ttl_seconds()
    hit = _CACHE.get(llave)
    if ttl and hit and hit[0] > time.monotonic():
        return hit[1]

    ini, fin = rango_de(mes)
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
    info_docs = {
        r["doc_id"]: {
            "doc_id": r["doc_id"],
            "documento": str(r["doc_id"]).split("|")[-1],
            "compensacion": r.get("augbl"),
            "texto": r.get("texto"),
            "fecha_pago": _iso(r.get("fecha_pago")),
        }
        for r in filas_docs
    }
    docs = [DocPago.desde_fila(r) for r in filas_docs]
    suma: dict[tuple, float] = {}
    partes: dict[FilaKey, dict[str, dict]] = {}
    for r in filas_diario:
        comision = float(r["comision"] or 0.0)
        fila_key = (r["sociedad"], r["comisionista_id"], r["division_code"])
        suma[(*fila_key, r["fecha"])] = suma.get((*fila_key, r["fecha"]), 0.0) + comision
        origen = r.get("origen") or r["division_code"]
        por_fecha = partes.setdefault(fila_key, {}).setdefault(origen, {})
        por_fecha[r["fecha"]] = por_fecha.get(r["fecha"], 0.0) + comision
    diario = [
        {"sociedad": s, "comisionista_id": c, "division_code": d, "fecha": f, "comision": m}
        for (s, c, d, f), m in suma.items()
    ]
    datos = (ini, fin, docs, diario, nombres, cobertura_datos, partes, info_docs)
    if ttl:
        _CACHE[llave] = (time.monotonic() + ttl, datos)
    return datos


def _cargar(mes: str, sociedad, division, comisionista_id, con_cobertura: bool = False):
    """Todas las filas resueltas, con el estado guardado de cada una aplicado."""
    ini, fin, docs, diario, nombres, cobertura_datos, _, info_docs = _datos(mes, sociedad, division, comisionista_id, con_cobertura)
    cierres = _cierres()
    claves = list(agrupar_pagos(docs, cierres=cierres))
    guardados = get_store().leer(claves)
    estados = {k: d.a_estado() for k, d in guardados.items()}
    resueltas = construir_filas(docs, diario, estados, (ini, fin), cierres=cierres)
    versiones = {k: d.version for k, d in guardados.items()}
    return ini, fin, resueltas, nombres, diario, cobertura_datos, versiones, info_docs, guardados


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
        "dias_asignar": [_iso(d) for d in s.dias_asignar],
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


def _pago_json(p: PagoResuelto, info_docs: dict | None = None, doc: DocFila | None = None) -> dict:
    info_docs = info_docs or {}
    quien = (doc.consolidados_info.get(p.pago_id) if doc else None) or {}
    return {
        "pago_id": p.pago_id,
        "docs": list(p.docs),
        # Lo que dice SAP de cada documento: su número, la compensación (el pago) y el texto con que se pagó.
        "documentos": [info_docs[d] for d in p.docs if d in info_docs],
        "ini": _iso(p.ini),
        "fin": _iso(p.fin),
        "ini_default": _iso(p.ini_default),
        "fin_default": _iso(p.fin_default),
        "pagado": p.pagado,
        "calculado": p.calculado,
        "diferencia": p.diferencia,
        "estado": p.estado,
        "sin_calculo": p.sin_calculo,
        "dias_asignados": [_iso(d) for d in p.dias_asignados],
        "drift": p.drift,
        "drift_pagado": p.drift_pagado,
        "comentarios": (doc.comentarios.get(p.pago_id, []) if doc else []),
        "consolidado_por": quien.get("por"),
        "consolidado_en": quien.get("ts"),
        "descartada": p.descartada,
        "ajustado": p.ajustado,
        "sugerencia": _sugerencia_json(p.sugerencia),
    }


def _partes_json(key: FilaKey, partes: dict) -> dict:
    origenes = partes.get(key) or {}
    if len(origenes) < 2 and not DIVISIONES_JUNTAS.get((key[0], key[2])):
        return {}
    return {
        origen: sorted(([_iso(f), m] for f, m in por_fecha.items()), key=lambda x: x[0])
        for origen, por_fecha in origenes.items()
    }


def _rango_cargado(ini: date, fin: date) -> tuple[date, date]:
    return ini - timedelta(days=MARGEN_DIAS), fin + timedelta(days=MARGEN_DIAS)


def _huerfanos(fila: FilaResuelta, doc: DocFila | None, rango: tuple[date, date] | None) -> list[dict]:
    """Ajustes o consolidados guardados de un documento que debería estar en el rango cargado y ya no está en SAP."""
    if doc is None or rango is None:
        return []
    presentes = {p.pago_id for p in fila.pagos}
    salida = []
    for pago_id in sorted((set(doc.overrides) | set(doc.consolidados)) - presentes):
        foto = doc.consolidados.get(pago_id)
        if foto:
            ini, fin, tipo = foto.ini, foto.fin, "consolidado"
        else:
            ov = doc.overrides.get(pago_id, {})
            ini, fin, tipo = ov.get("ini"), ov.get("fin"), "ajuste"
        fechas = [d for d in (ini, fin) if d]
        if not fechas or not any(rango[0] <= d <= rango[1] for d in fechas):
            continue
        salida.append({"pago_id": pago_id, "tipo": tipo, "ini": _iso(ini), "fin": _iso(fin)})
    return salida


def _lote(fila: FilaResuelta, ini: date, fin: date) -> list[str]:
    """Pagos del mes que "Consolidar lo que cuadra" cierra: de izquierda a derecha, hasta el primero que no cuadra.

    Se corta ahí a propósito: consolidar un pago congela sus cortes, y uno que aún no cuadra puede necesitar
    moverlos.
    """
    plan = []
    for p in fila.pagos:
        if p.estado == SIN_VENTANA or not _toca_el_mes(p, ini, fin) or p.estado == CONSOLIDADO:
            continue
        if p.estado != OK:
            break
        plan.append(p.pago_id)
    return plan


def _fila_json(
    fila: FilaResuelta,
    nombre: str | None,
    pagos: list[PagoResuelto],
    version: int = 0,
    info_docs: dict | None = None,
    doc: DocFila | None = None,
    rango: tuple[date, date] | None = None,
    lote: list[str] | None = None,
) -> dict:
    sociedad, comisionista_id, division_code = fila.key
    return {
        "fila_id": f"{sociedad}|{comisionista_id}|{division_code or ''}",
        "sociedad": sociedad,
        "comisionista_id": comisionista_id,
        "comisionista": nombre,
        "division_code": division_code,
        "version": version,
        # Divisiones que este pago cubre además de la suya (Huevo de DBC paga también Abarrotes).
        "junta_con": list(DIVISIONES_JUNTAS.get((sociedad, division_code), ())),
        "pagos": [_pago_json(p, info_docs, doc) for p in pagos],
        "huerfanos": _huerfanos(fila, doc, rango),
        "lote": lote or [],
        "huecos": [
            {"ini": _iso(h.ini), "fin": _iso(h.fin), "comision": h.comision, "despues_de": h.despues_de, "antes_de": h.antes_de, "cierre": h.cierre}
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


def build_mes(*, mes: str | None = None, desde: date | None = None, hasta: date | None = None, sociedad=None, division=None, comisionista_id=None) -> dict:
    """La lista del mes (o de las semanas pedidas con desde/hasta): una fila por sociedad × comisionista × división, con los pagos que tocan el rango."""
    if desde and hasta:
        periodo = (desde, hasta)
    elif mes:
        periodo = mes
    else:
        raise ValueError("Falta el mes o el rango de fechas.")
    ini, fin, filas, nombres, _, cobertura_datos, versiones, info_docs, guardados = _cargar(
        periodo, sociedad, division, comisionista_id, con_cobertura=True
    )
    salida = []
    for key, fila in filas.items():
        pagos = [p for p in fila.pagos if _toca_el_mes(p, ini, fin)]
        if pagos:
            salida.append(
                _fila_json(
                    fila, nombres.get(key[1]), pagos, versiones.get(key, 0), info_docs,
                    doc=guardados.get(key), rango=_rango_cargado(ini, fin), lote=_lote(fila, ini, fin),
                )
            )
    salida.sort(key=lambda f: (f["comisionista"] is None, f["comisionista"] or f["comisionista_id"], f["division_code"] or ""))
    return {
        "mes": mes or ini.strftime("%Y-%m"),
        "desde": ini.isoformat(),
        "hasta": fin.isoformat(),
        "cobertura": cobertura_datos,
        "filas": salida,
    }


def _num(v):
    return float(v) if hasattr(v, "as_tuple") else v


_SUMAS_PRODUCTO = ("num_lineas", "cantidad_venta_total", "monto_total", "cantidad_base_total", "comision_total", "lineas_sin_comision")


def _productos(diario: list[dict], ini: date, fin: date) -> list[dict]:
    """El diario sumado por periodo y producto (la hoja "Conciliación" de la pestaña vigente): la ventana del pago es un
    periodo y cada día de cierre asignado a mano, otro."""
    grupos: dict[tuple, dict] = {}
    for r in diario:
        dia = date.fromisoformat(r["fecha"])
        desde, hasta = (ini, fin) if ini <= dia <= fin else (dia, dia)
        llave = (desde, hasta) + tuple(r.get(c) for c in ("division_code", "cedis", "oficina", "tipo_venta", "matnr", "descripcion", "unidad_venta", "unidad_tarifa"))
        g = grupos.setdefault(
            llave,
            {**{k: v for k, v in r.items() if k not in ("fecha", "asignacion")}, **{c: 0.0 for c in _SUMAS_PRODUCTO},
             "semana": desde.isoformat(), "periodo_fin": hasta.isoformat()},
        )
        for c in _SUMAS_PRODUCTO:
            g[c] += r.get(c) or 0.0
    return sorted(grupos.values(), key=lambda g: (g["semana"], g["cedis"] is None, g["cedis"] or "", g["oficina"] or "", -(g["cantidad_venta_total"] or 0)))


def build_export_pago(
    *, sociedad: str, comisionista_id: str, division_code: str | None, ini: date, fin: date, dias: list[date] | None = None
) -> dict:
    """Todo lo que lleva el Excel de UN pago: los cobros de su ventana (más los días de cierre que tenga asignados)
    por producto, por día y por línea de factura, con su división de origen (Huevo y Abarrotes juntos)."""
    asignados = sorted(set(dias or ()))
    params = {
        "ini": ("DATE", min([ini, *asignados])),
        "fin": ("DATE", max([fin, *asignados])),
        "sociedad": ("STRING", sociedad),
        "comisionista_id": ("STRING", comisionista_id),
        "division": ("STRING", division_code),
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_diario = pool.submit(run_query, _DIARIO_PAGO_SQL, "el detalle diario del pago", params)
        f_factura = pool.submit(run_query, _FACTURA_PAGO_SQL, "el detalle de factura del pago", params)
        diario, factura = f_diario.result(), f_factura.result()

    def motivo(dia: date) -> str | None:
        if ini <= dia <= fin:
            return "Ventana del pago"
        return "Cierre de mes asignado" if dia in asignados else None

    def limpio(r: dict, campo: str) -> dict | None:
        m = motivo(r[campo]) if r.get(campo) else None
        if m is None:
            return None
        salida = {k: _num(v) for k, v in r.items()}
        for c in ("fecha", "fecha_cobro"):
            if c in salida:
                salida[c] = _iso(salida[c])
        salida["asignacion"] = m
        return salida

    diario_p = [x for x in (limpio(r, "fecha") for r in diario) if x]
    factura_p = [x for x in (limpio(r, "fecha_cobro") for r in factura) if x]
    diario_p.sort(key=lambda r: (r["fecha"], r["cedis"] or "", r["oficina"] or ""))
    factura_p.sort(key=lambda r: (r["fecha_cobro"], r["cedis"] or "", r["oficina"] or "", str(r["billing_document"]), str(r["item_number"])))
    return {
        "ini": ini.isoformat(),
        "fin": fin.isoformat(),
        "dias": [_iso(d) for d in asignados],
        "productos": _productos(diario_p, ini, fin),
        "diario": diario_p,
        "factura": factura_p,
    }


def _vista_fila(mes: str, key: FilaKey, doc: DocFila) -> dict:
    """La fila resuelta con el estado `doc`, más los cobros diarios (sin volver a BigQuery si está en caché)."""
    sociedad, comisionista_id, division_code = key
    _, _, docs, diario, nombres, _, partes, info_docs = _datos(mes, sociedad, division_code, comisionista_id)
    cierres = _cierres()
    pagos = agrupar_pagos(docs, cierres=cierres).get(key)
    if not pagos:
        return {"mes": mes, "fila": None, "dias": [], "dias_partes": {}}
    dias = {r["fecha"]: r["comision"] for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key}
    fila = resolver_fila(key, pagos, SerieDiaria(dias), doc.a_estado(), cierres=cierres)
    return {
        "mes": mes,
        "fila": _fila_json(
            fila, nombres.get(comisionista_id), fila.pagos, doc.version, info_docs,
            doc=doc, rango=_rango_cargado(*rango_mes(mes)), lote=_lote(fila, *rango_mes(mes)),
        ),
        "dias": sorted(([_iso(f), m] for f, m in dias.items()), key=lambda x: x[0]),
        # Solo cuando la fila junta varias divisiones: los cobros diarios de cada una.
        "dias_partes": _partes_json(key, partes),
    }


def build_fila(*, mes: str, sociedad: str, comisionista_id: str, division_code: str | None) -> dict:
    """El panel de una fila: todos sus pagos del rango cargado y los cobros diarios para dibujar la línea de tiempo."""
    key = (sociedad, comisionista_id, division_code)
    doc = get_store().leer([key]).get(key) or DocFila()
    return _vista_fila(mes, key, doc)


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


# ─── Ediciones ───────────────────────────────────────────────────────────
#
# Cada edición: lee el estado guardado, comprueba que la persona vio la última
# versión, resuelve la fila, calcula el nuevo estado con el motor, lo guarda
# (transacción con la versión que se leyó) y devuelve la fila actualizada.


def _contexto_edicion(mes: str, key: FilaKey, version: int):
    sociedad, comisionista_id, division_code = key
    _, _, docs, diario, _, _, _, _ = _datos(mes, sociedad, division_code, comisionista_id)
    doc = get_store().leer([key]).get(key) or DocFila()
    if doc.version != version:
        raise ConflictoVersion("La fila cambió mientras la editabas. Se recargó con lo último.")
    cierres = _cierres()
    pagos = agrupar_pagos(docs, cierres=cierres).get(key)
    if not pagos:
        raise ErrorCorte("fila_inexistente", "No hay pagos de esa fila en el rango cargado.")
    dias = {r["fecha"]: r["comision"] for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key}
    fila = resolver_fila(key, pagos, SerieDiaria(dias), doc.a_estado(), cierres=cierres)
    return doc, fila


def _pago(fila: FilaResuelta, pago_id: str) -> PagoResuelto:
    try:
        return fila.pago(pago_id)
    except KeyError:
        raise ErrorCorte("pago_inexistente", "Ese pago ya no está en la fila.") from None


def _ov_json(overrides: dict, ids=None) -> dict:
    return {
        pid: {b: f.isoformat() for b, f in v.items()}
        for pid, v in overrides.items()
        if ids is None or pid in ids
    }


def _escribir(
    mes, key, doc, usuario, tipo, *, pago_id, overrides=None, descartadas=None, consolidados=None,
    consolidados_info=None, dias_asignados=None, comentarios=None, detalle=None,
) -> DocFila:
    """Guarda el nuevo estado de la fila (transacción con la versión que se leyó) y su evento en el historial."""
    nuevo = DocFila(
        version=doc.version,
        overrides=doc.overrides if overrides is None else overrides,
        descartadas=doc.descartadas if descartadas is None else descartadas,
        consolidados=doc.consolidados if consolidados is None else consolidados,
        consolidados_info=doc.consolidados_info if consolidados_info is None else consolidados_info,
        dias_asignados=doc.dias_asignados if dias_asignados is None else dias_asignados,
        comentarios=doc.comentarios if comentarios is None else comentarios,
    )
    cambiados = {
        pid for pid in set(doc.overrides) | set(nuevo.overrides) if doc.overrides.get(pid) != nuevo.overrides.get(pid)
    }
    evento = {
        "tipo": tipo,
        "usuario": usuario,
        "pago_id": pago_id,
        "mes": mes,
        "antes": _ov_json(doc.overrides, cambiados),
        "despues": _ov_json(nuevo.overrides, cambiados),
    }
    if detalle:
        evento["detalle"] = detalle
    return get_store().escribir(key, doc.version, nuevo, evento)


def _guardar(mes, key, doc, usuario, tipo, **kwargs):
    return _vista_fila(mes, key, _escribir(mes, key, doc, usuario, tipo, **kwargs))


def mover_corte(*, mes, key, izq_pago_id, fecha: date, version, usuario) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, izq_pago_id)
    overrides = fila.mover_corte(izq_pago_id, fecha)
    return _guardar(mes, key, doc, usuario, "mover_corte", pago_id=izq_pago_id, overrides=overrides,
                    detalle={"fecha": fecha.isoformat()})


def mover_borde(*, mes, key, pago_id, borde, fecha: date, version, usuario) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    overrides = fila.mover_borde(pago_id, borde, fecha)
    return _guardar(mes, key, doc, usuario, "mover_borde", pago_id=pago_id, overrides=overrides,
                    detalle={"borde": borde, "fecha": fecha.isoformat()})


def _firma(cambios) -> set:
    """Los cambios de una sugerencia como conjunto comparable (vengan del motor o del cliente)."""
    return {
        (c.pago_id, c.borde, _iso(c.de), _iso(c.a))
        if isinstance(c, CambioBorde)
        else (c["pago_id"], c["borde"], str(c["de"]), str(c["a"]))
        for c in cambios
    }


def aplicar_sugerencia(*, mes, key, pago_id, cambios_vistos, version, usuario, dias_vistos=None) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    sugerencia = _pago(fila, pago_id).sugerencia
    if sugerencia is None:
        raise ErrorCorte("sin_sugerencia", "Este pago ya no tiene una sugerencia que aplicar.")
    if cambios_vistos is not None and _firma(cambios_vistos) != _firma(sugerencia.cambios):
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    if dias_vistos is not None and {_iso(d) for d in dias_vistos} != {_iso(d) for d in sugerencia.dias_asignar}:
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    descartadas = {k: v for k, v in doc.descartadas.items() if k != pago_id}
    if sugerencia.tipo == "cierre":
        return _guardar(mes, key, doc, usuario, "aplicar_sugerencia", pago_id=pago_id,
                        dias_asignados=fila.con_dias(sugerencia), descartadas=descartadas,
                        detalle={"dias": ",".join(_iso(d) for d in sugerencia.dias_asignar)})
    overrides = fila.aplicar_sugerencia(sugerencia)
    return _guardar(mes, key, doc, usuario, "aplicar_sugerencia", pago_id=pago_id, overrides=overrides,
                    descartadas=descartadas)


def descartar_sugerencia(*, mes, key, pago_id, version, usuario) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    descartadas = {**doc.descartadas, pago_id: {"por": usuario, "ts": ahora_iso()}}
    return _guardar(mes, key, doc, usuario, "descartar_sugerencia", pago_id=pago_id, descartadas=descartadas)


def recuperar_sugerencia(*, mes, key, pago_id, version, usuario) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    descartadas = {k: v for k, v in doc.descartadas.items() if k != pago_id}
    return _guardar(mes, key, doc, usuario, "recuperar_sugerencia", pago_id=pago_id, descartadas=descartadas)


def asignar_dias(*, mes, key, pago_id, dias: list[date], version, usuario) -> dict:
    """Deja como días de cierre de este pago los dados (a mano, sin sugerencia); lista vacía = quitarlos todos."""
    doc, fila = _contexto_edicion(mes, key, version)
    pago = _pago(fila, pago_id)
    if pago.estado == CONSOLIDADO:
        raise ErrorCorte("corte_congelado", "El pago está consolidado.")
    if pago.ini is None:
        raise ErrorCorte("sin_ventana", "El pago no tiene ventana.")
    de_otros = {d for pid, ds in doc.dias_asignados.items() if pid != pago_id for d in ds}
    libres = {
        h.ini + timedelta(days=k)
        for h in fila.huecos
        if h.cierre
        for k in range((h.fin - h.ini).days + 1)
    } - de_otros
    permitidos = libres | set(pago.dias_asignados)
    if not set(dias) <= permitidos:
        raise ErrorCorte("dia_no_libre", "Solo se asignan días de cierre de mes sin pago; alguno ya no está libre.")
    nuevo = {k: v for k, v in doc.dias_asignados.items() if k != pago_id}
    if dias:
        nuevo[pago_id] = sorted(set(dias))
    return _guardar(mes, key, doc, usuario, "asignar_dias", pago_id=pago_id, dias_asignados=nuevo,
                    detalle={"dias": ",".join(_iso(d) for d in sorted(set(dias)))})


MAX_COMENTARIO = 1000


def comentar(*, mes, key, pago_id, texto: str, version, usuario) -> dict:
    """Agrega un comentario al pago (queda con quién y cuándo). Sirve para documentar, p. ej., un error humano."""
    texto = (texto or "").strip()
    if not texto:
        raise ErrorCorte("comentario_vacio", "Escribe el comentario.")
    if len(texto) > MAX_COMENTARIO:
        raise ErrorCorte("comentario_largo", f"El comentario no puede pasar de {MAX_COMENTARIO} caracteres.")
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    nuevo = {"id": uuid.uuid4().hex[:10], "texto": texto, "por": usuario, "ts": ahora_iso()}
    comentarios = {**doc.comentarios, pago_id: [*doc.comentarios.get(pago_id, []), nuevo]}
    return _guardar(mes, key, doc, usuario, "comentar", pago_id=pago_id, comentarios=comentarios,
                    detalle={"texto": texto[:200]})


def borrar_comentario(*, mes, key, pago_id, comentario_id: str, version, usuario) -> dict:
    """Quita un comentario; solo lo borra quien lo escribió (para corregir un error al teclear)."""
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    propios = doc.comentarios.get(pago_id, [])
    comentario = next((c for c in propios if c.get("id") == comentario_id), None)
    if comentario is None:
        raise ErrorCorte("comentario_inexistente", "Ese comentario ya no existe.")
    if comentario.get("por") != usuario:
        raise ErrorCorte("comentario_ajeno", "Solo quien escribió el comentario puede borrarlo.")
    restantes = [c for c in propios if c.get("id") != comentario_id]
    comentarios = {k: v for k, v in doc.comentarios.items() if k != pago_id}
    if restantes:
        comentarios[pago_id] = restantes
    return _guardar(mes, key, doc, usuario, "borrar_comentario", pago_id=pago_id, comentarios=comentarios,
                    detalle={"texto": str(comentario.get("texto", ""))[:200]})


def restablecer_pago(*, mes, key, pago_id, version, usuario) -> dict:
    """Vuelve la ventana de un pago a la que propone el texto, junto con el borde que comparte con sus vecinos."""
    doc, fila = _contexto_edicion(mes, key, version)
    pago = _pago(fila, pago_id)
    if pago.estado == "cons":
        raise ErrorCorte("corte_congelado", "El pago está consolidado.")
    overrides = {k: dict(v) for k, v in doc.overrides.items()}
    overrides.pop(pago_id, None)
    dias_asignados = {k: v for k, v in doc.dias_asignados.items() if k != pago_id}
    for c in fila.cortes:
        if pago_id not in (c.izq, c.der):
            continue
        if c.congelado:
            raise ErrorCorte("corte_congelado", "Un corte de este pago está congelado.")
        if c.izq == pago_id and c.der in overrides:
            overrides[c.der].pop("ini", None)
        if c.der == pago_id and c.izq in overrides:
            overrides[c.izq].pop("fin", None)
    overrides = {k: v for k, v in overrides.items() if v}
    return _guardar(mes, key, doc, usuario, "restablecer_pago", pago_id=pago_id, overrides=overrides,
                    dias_asignados=dias_asignados)


def build_historial(*, key: FilaKey, limite: int = 30) -> dict:
    return {"eventos": get_store().historial(key, limite)}


# ─── Consolidar, reabrir y fijar la ventana de un pago sin texto legible ──


def _texto_foto(foto) -> dict:
    return {
        "ini": foto.ini.isoformat(),
        "fin": foto.fin.isoformat(),
        "pagado": f"{foto.pagado:.2f}",
        "calculado": f"{foto.calculado:.2f}",
    }


def consolidar(*, mes, key, pago_id, version, usuario) -> dict:
    """Congela el pago: guarda su ventana, lo pagado y lo calculado de hoy, y sus dos cortes dejan de moverse."""
    doc, fila = _contexto_edicion(mes, key, version)
    _pago(fila, pago_id)
    foto = fila.foto(pago_id)  # ya consolidado o sin ventana: ErrorCorte
    return _guardar(
        mes, key, doc, usuario, "consolidar", pago_id=pago_id,
        consolidados={**doc.consolidados, pago_id: foto},
        consolidados_info={**doc.consolidados_info, pago_id: {"por": usuario, "ts": ahora_iso()}},
        detalle=_texto_foto(foto),
    )


def reabrir(*, mes, key, pago_ids, version, usuario) -> dict:
    """Quita la foto de uno o más pagos: vuelven a su ventana ajustada (o a la del texto) y a recalcularse."""
    doc, _ = _contexto_edicion(mes, key, version)
    faltan = [p for p in pago_ids if p not in doc.consolidados]
    if faltan:
        raise ErrorCorte("no_consolidado", "Alguno de esos pagos no está consolidado.")
    return _guardar(
        mes, key, doc, usuario, "reabrir", pago_id=pago_ids[0],
        consolidados={k: v for k, v in doc.consolidados.items() if k not in pago_ids},
        consolidados_info={k: v for k, v in doc.consolidados_info.items() if k not in pago_ids},
        detalle={"pagos": ",".join(pago_ids)},
    )


def consolidar_lote(*, mes: str | None = None, desde: date | None = None, hasta: date | None = None, fila_ids: list[str], usuario: str) -> dict:
    """Consolida lo que cuadra en las filas pedidas, con el plan que arma el servidor (izquierda a derecha)."""
    periodo = (desde, hasta) if desde and hasta else mes
    ini, fin, filas, _, _, _, versiones, _, guardados = _cargar(periodo, None, None, None)
    pedidas = set(fila_ids)
    total = filas_tocadas = omitidas = 0
    for key, fila in filas.items():
        if f"{key[0]}|{key[1]}|{key[2] or ''}" not in pedidas:
            continue
        plan = _lote(fila, ini, fin)
        if not plan:
            continue
        doc = guardados.get(key) or DocFila()
        fotos = {pid: fila.foto(pid) for pid in plan}
        ahora = ahora_iso()
        try:
            _escribir(
                mes, key, doc, usuario, "consolidar_lote", pago_id=plan[0],
                consolidados={**doc.consolidados, **fotos},
                consolidados_info={**doc.consolidados_info, **{pid: {"por": usuario, "ts": ahora} for pid in plan}},
                detalle={"pagos": ",".join(plan)},
            )
        except ConflictoVersion:
            omitidas += 1  # otra persona tocó esa fila: se deja como está
            continue
        total += len(plan)
        filas_tocadas += 1
    return {"consolidados": total, "filas": filas_tocadas, "omitidas": omitidas}


def fijar_ventana(*, mes, key, pago_id, ini: date, fin: date, version, usuario) -> dict:
    """Da una ventana a un pago cuyo texto no la trae (o corrige la que se le dio antes)."""
    doc, fila = _contexto_edicion(mes, key, version)
    pago = _pago(fila, pago_id)
    if pago.estado == CONSOLIDADO:
        raise ErrorCorte("corte_congelado", "El pago está consolidado.")
    if pago.ini_default is not None or pago.fin_default is not None:
        raise ErrorCorte("tiene_ventana", "Este pago ya tiene ventana en el texto: muévela con sus cortes.")
    if ini > fin:
        raise ErrorCorte("ventana_invalida", "El inicio no puede ser posterior al fin.")
    overrides = {k: dict(v) for k, v in doc.overrides.items()}
    overrides[pago_id] = {"ini": ini, "fin": fin}
    return _guardar(
        mes, key, doc, usuario, "fijar_ventana", pago_id=pago_id, overrides=overrides,
        detalle={"ini": ini.isoformat(), "fin": fin.isoformat()},
    )


def quitar_huerfano(*, mes, key, pago_id, version, usuario) -> dict:
    """Borra el ajuste o la foto de un documento que ya no está en SAP."""
    doc, fila = _contexto_edicion(mes, key, version)
    if pago_id in {p.pago_id for p in fila.pagos}:
        raise ErrorCorte("no_huerfano", "Ese documento sigue en SAP.")
    return _guardar(
        mes, key, doc, usuario, "quitar_huerfano", pago_id=pago_id,
        overrides={k: v for k, v in doc.overrides.items() if k != pago_id},
        descartadas={k: v for k, v in doc.descartadas.items() if k != pago_id},
        consolidados={k: v for k, v in doc.consolidados.items() if k != pago_id},
        consolidados_info={k: v for k, v in doc.consolidados_info.items() if k != pago_id},
    )
