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
import logging
import threading
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

# Documentos que no se muestran: su texto no sigue el patrón de las comisiones semanales y quedaban sin división ni ventana
# ("COMISION DE LECHE", $575; "COMISION RUTA ESPECIALIZADA CROQUETA", $5,105). Igual que el filtro de la tabla, que al
# recargarse ya no los trae; aquí se quitan para que desaparezcan sin esperar la recarga.
DOCS_EXCLUIDOS = ("DBC|2026|5100003892", "DBC|2025|5100019700")
_FILTRO_DOCS_EXCLUIDOS = "doc_id NOT IN (" + ", ".join(f"'{d}'" for d in DOCS_EXCLUIDOS) + ")"
_TABLA_DIARIA = "`proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`"
_TABLA_VENDORS = "`proan-quantrue.D20_DIMENSION.dm_vendors`"
_TABLA_LINEA = "`proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_linea`"

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
  AND d.{_FILTRO_DOCS_EXCLUIDOS}
  AND (
    (d.ventana_valida AND d.desde_texto <= @fin_ext AND d.hasta_texto >= @ini_ext)
    OR (NOT d.ventana_valida AND d.fecha_pago BETWEEN @ini AND @fin_pago)
  )
"""

# `division_pago` es la división con la que se paga: Abarrotes de DBC se cobra junto con Huevo.
_DIVISION_PAGO_SQL = "IF(sociedad = 'DBC' AND division_code = 'A', 'H', division_code)"

# Botana hasta agosto: la comisión de estos 4 materiales no se pagó en su semana (se paga aparte, poco a poco);
# se separa del cálculo de la semana y cada semana se mueve entera al pago que la pagó.
SKUS_DIFERIDOS = ("17126", "17401", "17402", "17630")
SKUS_DIFERIDOS_HASTA = date(2026, 8, 31)
_ES_SKU_DIFERIDO_SQL = (
    "(division_code = 'BO' AND LTRIM(matnr, '0') IN ("
    + ", ".join(f"'{m}'" for m in SKUS_DIFERIDOS)
    + f") AND fecha <= DATE '{SKUS_DIFERIDOS_HASTA.isoformat()}')"
)

_DIARIO_SQL = f"""
SELECT sociedad, comisionista_id, {_DIVISION_PAGO_SQL} AS division_code, division_code AS origen,
       fecha, SUM(IF({_ES_SKU_DIFERIDO_SQL}, 0, comision_total)) AS comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini_ext AND @fin_ext
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY 1, 2, 3, 4, 5
"""

# La comisión diaria de los 4 SKUs de enero al corte, sin importar el rango pedido: una semana de julio se puede mover a un pago de octubre.
_SKUS_SQL = f"""
SELECT sociedad, comisionista_id, {_DIVISION_PAGO_SQL} AS division_code, fecha, SUM(comision_total) AS comision_4sku
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN DATE '2026-01-01' AND DATE '{SKUS_DIFERIDOS_HASTA.isoformat()}'
  AND {_ES_SKU_DIFERIDO_SQL}
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY 1, 2, 3, 4
HAVING SUM(comision_total) > 0
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


_CACHE_TTL_POR_DEFECTO = 300
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


# Cada caché guarda (vence, valor). Vencido, se sigue entregando lo guardado y se renueva en segundo plano: nadie espera a BigQuery
# por haber pasado unos minutos; solo la primera carga de cada bloque.
_CRUDO_CACHE: dict[tuple, tuple[float, tuple]] = {}
_SKUS_CACHE: dict[tuple, tuple[float, list]] = {}
_COBERTURA_CACHE: dict[tuple, tuple[float, dict]] = {}
_RENOVANDO: set = set()
_RENOVANDO_LOCK = threading.Lock()


def _cacheado(cache: dict, llave: tuple, cargar):
    ttl = _cache_ttl_seconds()
    if not ttl:
        return cargar()
    hit = cache.get(llave)
    ahora = time.monotonic()
    if hit and hit[0] > ahora:
        return hit[1]
    if hit:
        with _RENOVANDO_LOCK:
            renovar = (id(cache), llave) not in _RENOVANDO
            if renovar:
                _RENOVANDO.add((id(cache), llave))
        if renovar:
            def _trabajo():
                try:
                    cache[llave] = (time.monotonic() + ttl, cargar())
                except Exception:  # si falla, se sigue con lo anterior y se reintenta en la siguiente petición
                    logging.getLogger("comisionesbi").exception("No se pudo renovar la caché de cortes")
                finally:
                    with _RENOVANDO_LOCK:
                        _RENOVANDO.discard((id(cache), llave))

            threading.Thread(target=_trabajo, daemon=True).start()
        return hit[1]
    valor = cargar()
    cache[llave] = (ahora + ttl, valor)
    return valor


def _filtrar_filas(filas: list, sociedad, division, comisionista_id) -> list:
    """Los renglones de una sociedad, división y comisionista (los filtros en None no filtran)."""
    if sociedad is None and division is None and comisionista_id is None:
        return filas
    return [
        r for r in filas
        if (sociedad is None or r["sociedad"] == sociedad)
        and (division is None or r["division_code"] == division)
        and (comisionista_id is None or r["comisionista_id"] == comisionista_id)
    ]


def _bloque(ini: date, fin: date) -> tuple[date, date]:
    """El año de `ini` y el siguiente: el bloque depende solo del año en que arranca el rango, así que mover la ventana o abrir
    el panel de una fila casi nunca cambia de bloque (y se reutiliza lo ya bajado)."""
    return date(ini.year, 1, 1), date(max(fin.year, ini.year + 1), 12, 31)


def _crudo(ini_ext: date, fin_pago: date, sociedad, division, comisionista_id) -> tuple[list, list]:
    """Pagos por documento y cobros diarios del bloque de años que cubre el rango."""
    b_ini, b_fin = _bloque(ini_ext, fin_pago)

    def cargar():
        params = {
            "ini": ("DATE", b_ini),
            "fin_pago": ("DATE", b_fin),
            "ini_ext": ("DATE", b_ini),
            "fin_ext": ("DATE", b_fin),
            "sociedad": ("STRING", sociedad),
            "division": ("STRING", division),
            "comisionista_id": ("STRING", comisionista_id),
        }
        # Las consultas son independientes: en paralelo, la espera es la de la más lenta.
        with ThreadPoolExecutor(max_workers=2) as pool:
            f_docs = pool.submit(run_query, _DOCS_SQL, "los pagos por documento", params)
            f_diario = pool.submit(
                run_query,
                _DIARIO_SQL,
                "los cobros diarios por comisionista",
                {k: v for k, v in params.items() if k not in ("ini", "fin_pago")},
            )
            return f_docs.result(), f_diario.result()

    return _cacheado(_CRUDO_CACHE, (b_ini, b_fin, sociedad, division, comisionista_id), cargar)


def _crudo_skus(sociedad, division, comisionista_id) -> list:
    """La comisión diaria de los 4 SKUs (enero al corte): no depende del rango, se consulta una vez por filtro."""
    return _cacheado(
        _SKUS_CACHE,
        (sociedad, division, comisionista_id),
        lambda: run_query(
            _SKUS_SQL,
            "la comisión de los 4 SKUs",
            {"sociedad": ("STRING", sociedad), "division": ("STRING", division), "comisionista_id": ("STRING", comisionista_id)},
        ),
    )


def _cobertura_cacheada() -> dict:
    return _cacheado(_COBERTURA_CACHE, ("cobertura",), cobertura)


def precalentar(hoy: date | None = None) -> None:
    """Deja en caché lo que la pantalla pide al abrirse (el mes en curso con su contexto), para que la primera carga no espere."""
    hoy = hoy or date.today()
    _datos((hoy - timedelta(days=80), hoy + timedelta(days=14)), None, None, None, True)
    _cierres()


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
    ini_ext, fin_ext, fin_pago = ini - timedelta(days=MARGEN_DIAS), fin + timedelta(days=MARGEN_DIAS), fin + timedelta(days=GRACIA_SIN_VENTANA_DIAS)
    # Lo que se baja de BigQuery es un bloque de meses completos que cubre el rango: mover la ventana una semana casi
    # nunca cambia de bloque, así que casi nunca hay que volver a consultar. Después se recorta al rango pedido.
    # Siempre se baja (y se guarda) todo sin filtros y se filtra aquí: abrir el panel de una fila o filtrar no cuesta otra consulta.
    docs_bloque, diario_bloque = _crudo(ini_ext, fin_ext + timedelta(days=GRACIA_SIN_VENTANA_DIAS), None, None, None)
    docs_bloque = _filtrar_filas(docs_bloque, sociedad, division, comisionista_id)
    diario_bloque = _filtrar_filas(diario_bloque, sociedad, division, comisionista_id)
    filas_skus = _filtrar_filas(_crudo_skus(None, None, None), sociedad, division, comisionista_id)
    cobertura_datos = _cobertura_cacheada() if con_cobertura else None
    filas_docs = [
        r for r in docs_bloque
        if (r["ventana_valida"] and r["desde_texto"] <= fin_ext and r["hasta_texto"] >= ini_ext)
        or (not r["ventana_valida"] and ini <= r["fecha_pago"] <= fin_pago)
    ]
    filas_diario = [r for r in diario_bloque if ini_ext <= r["fecha"] <= fin_ext]
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
    suma4: dict[tuple, float] = {}
    partes: dict[FilaKey, dict[str, dict]] = {}
    for r in filas_diario:
        comision = float(r["comision"] or 0.0)
        fila_key = (r["sociedad"], r["comisionista_id"], r["division_code"])
        suma[(*fila_key, r["fecha"])] = suma.get((*fila_key, r["fecha"]), 0.0) + comision
        origen = r.get("origen") or r["division_code"]
        por_fecha = partes.setdefault(fila_key, {}).setdefault(origen, {})
        por_fecha[r["fecha"]] = por_fecha.get(r["fecha"], 0.0) + comision
    for r in filas_skus:
        k = (r["sociedad"], r["comisionista_id"], r["division_code"], r["fecha"])
        suma4[k] = suma4.get(k, 0.0) + float(r["comision_4sku"] or 0.0)
    diario = [
        {"sociedad": s, "comisionista_id": c, "division_code": d, "fecha": f, "comision": suma.get((s, c, d, f), 0.0),
         "comision_4sku": suma4.get((s, c, d, f), 0.0)}
        for (s, c, d, f) in {*suma, *suma4}
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
        "bloques_asignar": [_iso(d) for d in s.bloques_asignar],
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


def _sku_json(b: dict) -> dict:
    return {**b, "ini": _iso(b["ini"]), "fin": _iso(b["fin"])}


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
        "skus_incluidos": [_sku_json(b) for b in p.skus_incluidos],
        "skus_propios": [_sku_json(b) for b in p.skus_propios],
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
        "skus": [_sku_json(b) for b in fila.skus],
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


def _productos(diario: list[dict], ini: date, fin: date, bloques: list[tuple[date, date]] | None = None) -> list[dict]:
    """El diario sumado por periodo y producto (la hoja "Conciliación" de la pestaña vigente): la ventana del pago es un
    periodo y cada día de cierre asignado a mano, otro."""
    grupos: dict[tuple, dict] = {}
    for r in diario:
        dia = date.fromisoformat(r["fecha"])
        bloque = next(((a, b) for a, b in (bloques or ()) if a <= dia <= b), None) if r.get("sku_diferido") else None
        desde, hasta = bloque or ((ini, fin) if ini <= dia <= fin else (dia, dia))
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
    *, sociedad: str, comisionista_id: str, division_code: str | None, ini: date, fin: date, dias: list[date] | None = None,
    skus: list[tuple[date, date]] | None = None,
) -> dict:
    """Todo lo que lleva el Excel de UN pago: los cobros de su ventana (más los días de cierre que tenga asignados)
    por producto, por día y por línea de factura, con su división de origen (Huevo y Abarrotes juntos)."""
    asignados = sorted(set(dias or ()))
    bloques = sorted(set(skus or ()))
    params = {
        "ini": ("DATE", min([ini, *asignados, *(a for a, _ in bloques)])),
        "fin": ("DATE", max([fin, *asignados, *(b for _, b in bloques)])),
        "sociedad": ("STRING", sociedad),
        "comisionista_id": ("STRING", comisionista_id),
        "division": ("STRING", division_code),
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_diario = pool.submit(run_query, _DIARIO_PAGO_SQL, "el detalle diario del pago", params)
        f_factura = pool.submit(run_query, _FACTURA_PAGO_SQL, "el detalle de factura del pago", params)
        diario, factura = f_diario.result(), f_factura.result()

    def es_sku(r: dict, campo: str) -> bool:
        return (
            r.get("division_code") == "BO"
            and str(r.get("matnr") or "").lstrip("0") in SKUS_DIFERIDOS
            and r[campo] <= SKUS_DIFERIDOS_HASTA
        )

    def motivo(dia: date, sku: bool) -> str | None:
        if sku:
            # Los 4 SKUs solo van con la semana que se movió a este pago, esté o no dentro de su ventana.
            b = next(((a, z) for a, z in bloques if a <= dia <= z), None)
            return f"4 SKUs de la semana {b[0].isoformat()} a {b[1].isoformat()}" if b else None
        if ini <= dia <= fin:
            return "Ventana del pago"
        return "Cierre de mes asignado" if dia in asignados else None

    def limpio(r: dict, campo: str) -> dict | None:
        sku = bool(r.get(campo)) and es_sku(r, campo)
        m = motivo(r[campo], sku) if r.get(campo) else None
        if m is None:
            return None
        salida = {k: _num(v) for k, v in r.items()}
        salida["sku_diferido"] = sku
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
        "skus": [{"ini": a.isoformat(), "fin": b.isoformat()} for a, b in bloques],
        "productos": _productos(diario_p, ini, fin, bloques),
        "diario": diario_p,
        "factura": factura_p,
    }


# Lo que SAP pagó en cada línea de pasivo temporal del documento (detalle del pedido de la comisión).
_LINEAS_SQL = f"""
SELECT linea, pedido, posicion, texto_posicion, SUM(importe) AS importe
FROM {_TABLA_LINEA}
WHERE doc_id IN (@d0, @d1, @d2, @d3)
GROUP BY 1, 2, 3, 4
ORDER BY linea
"""

_FAMILIAS_SQL = f"""
SELECT fecha, LTRIM(matnr, '0') AS matnr, descripcion, SUM(comision_total) AS comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @ini AND @fin AND sociedad = @sociedad AND comisionista_id = @comisionista_id AND division_code = 'BO'
GROUP BY 1, 2, 3
"""

# Botana: la línea 01 del pedido es VUALA en tira, la 02 SW (cake y roll) y la 03 BIG (medido con José, 2026-10-29).
FAMILIAS_BOTANA = {"01": "VUALA en tira", "02": "SW (cake y roll)", "03": "BIG"}


def _familia_botana(descripcion: str | None) -> str:
    d = (descripcion or "").upper()
    return "03" if "BIG " in d else "02" if "SW " in d else "01"


def build_lineas_pago(
    *, sociedad: str, comisionista_id: str, division_code: str | None, docs: list[str], ini: date, fin: date,
    dias: list[date] | None = None, skus: list[tuple[date, date]] | None = None,
) -> dict:
    """Pagado por línea del pedido contra calculado por familia de producto (solo Botana, que es donde las
    líneas son familias). El calculado cubre lo mismo que el pago: su ventana, los días de cierre asignados y
    las semanas de 4 SKUs que incluye."""
    if division_code != "BO" or not docs:
        return {"lineas": []}
    asignados, bloques = set(dias or ()), sorted(set(skus or ()))
    ids = (list(docs) + [None] * 4)[:4]
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_lineas = pool.submit(
            run_query, _LINEAS_SQL, "las líneas del pedido del pago", {f"d{i}": ("STRING", d) for i, d in enumerate(ids)}
        )
        f_calc = pool.submit(
            run_query,
            _FAMILIAS_SQL,
            "el calculado por familia del pago",
            {
                "ini": ("DATE", min([ini, *asignados, *(a for a, _ in bloques)])),
                "fin": ("DATE", max([fin, *asignados, *(b for _, b in bloques)])),
                "sociedad": ("STRING", sociedad),
                "comisionista_id": ("STRING", comisionista_id),
            },
        )
        lineas, calc = f_lineas.result(), f_calc.result()
    calculado: dict[str, float] = {}
    for r in calc:
        dia = r["fecha"]
        if r["matnr"] in SKUS_DIFERIDOS and dia <= SKUS_DIFERIDOS_HASTA:
            incluida = any(a <= dia <= b for a, b in bloques)
        else:
            incluida = ini <= dia <= fin or dia in asignados
        if incluida:
            f = _familia_botana(r["descripcion"])
            calculado[f] = calculado.get(f, 0.0) + float(r["comision"] or 0.0)
    pagado = {r["linea"]: float(r["importe"] or 0.0) for r in lineas}
    posicion = next((r["texto_posicion"] for r in lineas if r.get("texto_posicion")), None)
    filas = [
        {
            "linea": f,
            "familia": FAMILIAS_BOTANA.get(f, f),
            "pagado": round(pagado.get(f, 0.0), 2),
            "calculado": round(calculado.get(f, 0.0), 2),
            "diferencia": round(calculado.get(f, 0.0) - pagado.get(f, 0.0), 2),
        }
        for f in sorted(set(pagado) | set(calculado) | set(FAMILIAS_BOTANA))
    ]
    return {"posicion": posicion, "lineas": filas if pagado else []}


# Lo pagado y lo calculado del año por sociedad y división, sin resolver pago por pago (rápido). Pagado: los pagos cuya
# ventana cae en el año (los sin ventana, por la fecha en que se pagaron). Calculado: la comisión de los cobros del año
# (Abarrotes de DBC dentro de Huevo, y los 4 SKUs de Botana aparte hasta el corte, que no se pagaron en su semana).
_ANIO_PAGADO_SQL = f"""
SELECT sociedad, division_code, SUM(pagado) AS pagado
FROM {_TABLA_PAGO_DOC}
WHERE IF(ventana_valida, EXTRACT(YEAR FROM desde_texto), EXTRACT(YEAR FROM fecha_pago)) = @anio
  AND {_FILTRO_DOCS_EXCLUIDOS}
  AND (@division IS NULL OR division_code = @division)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY 1, 2
"""

_ANIO_CALCULADO_SQL = f"""
SELECT sociedad, {_DIVISION_PAGO_SQL} AS division_code,
  SUM(IF({_ES_SKU_DIFERIDO_SQL}, 0, comision_total)) AS calculado,
  SUM(IF({_ES_SKU_DIFERIDO_SQL}, comision_total, 0)) AS skus
FROM {_TABLA_DIARIA}
WHERE EXTRACT(YEAR FROM fecha) = @anio
  AND (@division IS NULL OR {_DIVISION_PAGO_SQL} = @division)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
GROUP BY 1, 2
"""

_ANIO_CACHE: dict[tuple, tuple[float, dict]] = {}


def build_anio(*, anio: int, division: str | None = None, comisionista_id: str | None = None) -> dict:
    """Pagado y calculado del año por sociedad y división (con los mismos filtros de la pantalla), y lo que quedó
    apartado de los 4 SKUs de Botana. Abarrotes de DBC se paga dentro de Huevo, así que pedir "A" es pedir esa fila."""
    sociedad = None
    if division == "A":
        # solo DBC junta Abarrotes con Huevo; PAN no tiene esa división
        division, sociedad = "H", "DBC"
    llave = (anio, division, sociedad, comisionista_id)
    hit = _ANIO_CACHE.get(llave)
    ttl = _cache_ttl_seconds()
    if ttl and hit and hit[0] > time.monotonic():
        return hit[1]
    with ThreadPoolExecutor(max_workers=2) as pool:
        params = {
            "anio": ("INT64", anio),
            "division": ("STRING", division),
            "sociedad": ("STRING", sociedad),
            "comisionista_id": ("STRING", comisionista_id),
        }
        f_pagado = pool.submit(run_query, _ANIO_PAGADO_SQL, "el pagado del año", params)
        f_calc = pool.submit(run_query, _ANIO_CALCULADO_SQL, "el calculado del año", params)
        pagado, calculado = f_pagado.result(), f_calc.result()
    filas: dict[tuple, dict] = {}
    skus = 0.0
    for r in pagado:
        f = filas.setdefault((r["sociedad"], r["division_code"]), {"pagado": 0.0, "calculado": 0.0})
        f["pagado"] += float(r["pagado"] or 0.0)
    for r in calculado:
        f = filas.setdefault((r["sociedad"], r["division_code"]), {"pagado": 0.0, "calculado": 0.0})
        f["calculado"] += float(r["calculado"] or 0.0)
        skus += float(r["skus"] or 0.0)
    salida = [
        {"sociedad": s, "division_code": d, "pagado": round(v["pagado"], 2), "calculado": round(v["calculado"], 2)}
        for (s, d), v in sorted(filas.items(), key=lambda x: (x[0][0], x[0][1] or ""))
        if v["pagado"] or v["calculado"]
    ]
    resultado = {"anio": anio, "filas": salida, "skus_apartados": round(skus, 2)}
    if ttl:
        _ANIO_CACHE[llave] = (time.monotonic() + 5 * ttl, resultado)
    return resultado


def _vista_fila(mes: str, key: FilaKey, doc: DocFila) -> dict:
    """La fila resuelta con el estado `doc`, más los cobros diarios (sin volver a BigQuery si está en caché)."""
    sociedad, comisionista_id, division_code = key
    _, _, docs, diario, nombres, _, partes, info_docs = _datos(mes, sociedad, division_code, comisionista_id)
    cierres = _cierres()
    pagos = agrupar_pagos(docs, cierres=cierres).get(key)
    if not pagos:
        return {"mes": mes, "fila": None, "dias": [], "dias_partes": {}}
    dias = {r["fecha"]: r["comision"] for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key}
    serie, serie4 = _series(diario, key)
    fila = resolver_fila(key, pagos, serie, doc.a_estado(), cierres=cierres, serie4=serie4)
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
    serie, serie4 = _series(diario, key)
    fila = resolver_fila(key, pagos, serie, doc.a_estado(), cierres=cierres, serie4=serie4)
    return doc, fila


def _series(diario: list[dict], key: FilaKey) -> tuple[SerieDiaria, SerieDiaria]:
    """Comisión diaria de la fila (sin los 4 SKUs diferidos) y la de esos 4 SKUs."""
    propios = [r for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key]
    return (
        SerieDiaria({r["fecha"]: r["comision"] for r in propios if r["comision"]}),
        SerieDiaria({r["fecha"]: r.get("comision_4sku") or 0.0 for r in propios}),
    )


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
    consolidados_info=None, dias_asignados=None, comentarios=None, skus_movidos=None, detalle=None,
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
        skus_movidos=doc.skus_movidos if skus_movidos is None else skus_movidos,
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


def aplicar_sugerencia(*, mes, key, pago_id, cambios_vistos, version, usuario, dias_vistos=None, bloques_vistos=None) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    sugerencia = _pago(fila, pago_id).sugerencia
    if sugerencia is None:
        raise ErrorCorte("sin_sugerencia", "Este pago ya no tiene una sugerencia que aplicar.")
    if cambios_vistos is not None and _firma(cambios_vistos) != _firma(sugerencia.cambios):
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    if dias_vistos is not None and {_iso(d) for d in dias_vistos} != {_iso(d) for d in sugerencia.dias_asignar}:
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    if bloques_vistos is not None and {_iso(d) for d in bloques_vistos} != {_iso(d) for d in sugerencia.bloques_asignar}:
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    descartadas = {k: v for k, v in doc.descartadas.items() if k != pago_id}
    if sugerencia.tipo == "skus":
        nuevo = {**doc.skus_movidos, **{ini: pago_id for ini in sugerencia.bloques_asignar}}
        return _guardar(mes, key, doc, usuario, "aplicar_sugerencia", pago_id=pago_id, skus_movidos=nuevo,
                        descartadas=descartadas,
                        detalle={"bloques": ",".join(_iso(d) for d in sugerencia.bloques_asignar)})
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


def mover_skus(*, mes, key, bloques_ini: list[date], pago_id: str | None, version, usuario) -> dict:
    """Mueve las semanas de los 4 SKUs que empiezan en `bloques_ini` al pago dado; sin pago, vuelven a quedar sin pagar."""
    doc, fila = _contexto_edicion(mes, key, version)
    inis = sorted(set(bloques_ini))
    if not inis:
        raise ErrorCorte("bloque_inexistente", "Elige al menos una semana.")
    actuales = {}
    for ini in inis:
        bloque = next((b for b in fila.skus if b["ini"] == ini), None)
        if bloque is None:
            raise ErrorCorte("bloque_inexistente", "Esa semana ya no tiene comisión de los 4 SKUs.")
        actuales[ini] = bloque["pago_id"]
    for pid in {pago_id, *actuales.values()} - {None}:
        if _pago(fila, pid).estado == CONSOLIDADO:
            raise ErrorCorte("corte_congelado", "El pago está consolidado.")
    if pago_id and _pago(fila, pago_id).ini is None:
        raise ErrorCorte("sin_ventana", "El pago no tiene ventana.")
    nuevo = {k: v for k, v in doc.skus_movidos.items() if k not in inis}
    if pago_id:
        nuevo.update({ini: pago_id for ini in inis})
    origenes = sorted({p for p in actuales.values() if p})
    return _guardar(mes, key, doc, usuario, "mover_skus", pago_id=pago_id or (origenes[0] if origenes else ""),
                    skus_movidos=nuevo,
                    detalle={"bloques": ",".join(i.isoformat() for i in inis), "destino": pago_id or "", "origen": ",".join(origenes)})


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
