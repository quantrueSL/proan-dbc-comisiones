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
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from comisionesbi.conciliacion_cortes_engine import (
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
)
from comisionesbi.conciliacion_cortes_estado import (
    ConflictoVersion,
    DocFila,
    ahora_iso,
    get_store,
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


_CACHE_TTL_POR_DEFECTO = 120
# (mes, sociedad, división, comisionista, cobertura) -> (vence, datos crudos). Solo lo que viene de BigQuery.
_CACHE: dict[tuple, tuple[float, tuple]] = {}


def _cache_ttl_seconds() -> int:
    try:
        return max(int(os.getenv("CORTES_CACHE_TTL_SECONDS", "")), 0)
    except ValueError:
        return _CACHE_TTL_POR_DEFECTO


def _datos(mes: str, sociedad, division, comisionista_id, con_cobertura: bool = False):
    """Lo crudo de BigQuery: (ini, fin, docs, diario, nombres, cobertura)."""
    llave = (mes, sociedad, division, comisionista_id, con_cobertura)
    ttl = _cache_ttl_seconds()
    hit = _CACHE.get(llave)
    if ttl and hit and hit[0] > time.monotonic():
        return hit[1]

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
    datos = (ini, fin, docs, diario, nombres, cobertura_datos)
    if ttl:
        _CACHE[llave] = (time.monotonic() + ttl, datos)
    return datos


def _cargar(mes: str, sociedad, division, comisionista_id, con_cobertura: bool = False):
    """Todas las filas resueltas, con el estado guardado de cada una aplicado."""
    ini, fin, docs, diario, nombres, cobertura_datos = _datos(mes, sociedad, division, comisionista_id, con_cobertura)
    claves = list(agrupar_pagos(docs))
    guardados = get_store().leer(claves)
    estados = {k: d.a_estado() for k, d in guardados.items()}
    resueltas = construir_filas(docs, diario, estados, (ini, fin))
    versiones = {k: d.version for k, d in guardados.items()}
    return ini, fin, resueltas, nombres, diario, cobertura_datos, versiones


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
        "descartada": p.descartada,
        "ajustado": p.ajustado,
        "sugerencia": _sugerencia_json(p.sugerencia),
    }


def _fila_json(fila: FilaResuelta, nombre: str | None, pagos: list[PagoResuelto], version: int = 0) -> dict:
    sociedad, comisionista_id, division_code = fila.key
    return {
        "fila_id": f"{sociedad}|{comisionista_id}|{division_code or ''}",
        "sociedad": sociedad,
        "comisionista_id": comisionista_id,
        "comisionista": nombre,
        "division_code": division_code,
        "version": version,
        "pagos": [_pago_json(p) for p in pagos],
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


def build_mes(*, mes: str, sociedad=None, division=None, comisionista_id=None) -> dict:
    """La lista del mes: una fila por sociedad × comisionista × división, con los pagos que tocan el mes."""
    ini, fin, filas, nombres, _, cobertura_datos, versiones = _cargar(
        mes, sociedad, division, comisionista_id, con_cobertura=True
    )
    salida = []
    for key, fila in filas.items():
        pagos = [p for p in fila.pagos if _toca_el_mes(p, ini, fin)]
        if pagos:
            salida.append(_fila_json(fila, nombres.get(key[1]), pagos, versiones.get(key, 0)))
    salida.sort(key=lambda f: (f["comisionista"] is None, f["comisionista"] or f["comisionista_id"], f["division_code"] or ""))
    return {
        "mes": mes,
        "desde": ini.isoformat(),
        "hasta": fin.isoformat(),
        "cobertura": cobertura_datos,
        "filas": salida,
    }


def _vista_fila(mes: str, key: FilaKey, doc: DocFila) -> dict:
    """La fila resuelta con el estado `doc`, más los cobros diarios (sin volver a BigQuery si está en caché)."""
    sociedad, comisionista_id, division_code = key
    _, _, docs, diario, nombres, _ = _datos(mes, sociedad, division_code, comisionista_id)
    pagos = agrupar_pagos(docs).get(key)
    if not pagos:
        return {"mes": mes, "fila": None, "dias": []}
    dias = {r["fecha"]: r["comision"] for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key}
    fila = resolver_fila(key, pagos, SerieDiaria(dias), doc.a_estado())
    return {
        "mes": mes,
        "fila": _fila_json(fila, nombres.get(comisionista_id), fila.pagos, doc.version),
        "dias": sorted(([_iso(f), m] for f, m in dias.items()), key=lambda x: x[0]),
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
    _, _, docs, diario, _, _ = _datos(mes, sociedad, division_code, comisionista_id)
    doc = get_store().leer([key]).get(key) or DocFila()
    if doc.version != version:
        raise ConflictoVersion("La fila cambió mientras la editabas. Se recargó con lo último.")
    pagos = agrupar_pagos(docs).get(key)
    if not pagos:
        raise ErrorCorte("fila_inexistente", "No hay pagos de esa fila en el rango cargado.")
    dias = {r["fecha"]: r["comision"] for r in diario if (r["sociedad"], r["comisionista_id"], r["division_code"]) == key}
    fila = resolver_fila(key, pagos, SerieDiaria(dias), doc.a_estado())
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


def _guardar(mes, key, doc, usuario, tipo, *, pago_id, overrides=None, descartadas=None, detalle=None):
    nuevo = DocFila(
        version=doc.version,
        overrides=doc.overrides if overrides is None else overrides,
        descartadas=doc.descartadas if descartadas is None else descartadas,
        consolidados=doc.consolidados,
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
    guardado = get_store().escribir(key, doc.version, nuevo, evento)
    return _vista_fila(mes, key, guardado)


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


def aplicar_sugerencia(*, mes, key, pago_id, cambios_vistos, version, usuario) -> dict:
    doc, fila = _contexto_edicion(mes, key, version)
    sugerencia = _pago(fila, pago_id).sugerencia
    if sugerencia is None:
        raise ErrorCorte("sin_sugerencia", "Este pago ya no tiene una sugerencia que aplicar.")
    if cambios_vistos is not None and _firma(cambios_vistos) != _firma(sugerencia.cambios):
        raise ErrorCorte("sugerencia_distinta", "La sugerencia cambió desde que la viste. Revisa la nueva.")
    overrides = fila.aplicar_sugerencia(sugerencia)
    descartadas = {k: v for k, v in doc.descartadas.items() if k != pago_id}
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


def restablecer_pago(*, mes, key, pago_id, version, usuario) -> dict:
    """Vuelve la ventana de un pago a la que propone el texto, junto con el borde que comparte con sus vecinos."""
    doc, fila = _contexto_edicion(mes, key, version)
    pago = _pago(fila, pago_id)
    if pago.estado == "cons":
        raise ErrorCorte("corte_congelado", "El pago está consolidado.")
    overrides = {k: dict(v) for k, v in doc.overrides.items()}
    overrides.pop(pago_id, None)
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
    return _guardar(mes, key, doc, usuario, "restablecer_pago", pago_id=pago_id, overrides=overrides)


def build_historial(*, key: FilaKey, limite: int = 30) -> dict:
    return {"eventos": get_store().historial(key, limite)}
