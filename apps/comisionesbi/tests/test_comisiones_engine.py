"""Comisión: lo devengado, lo bloqueado, y que las dos cosas viajen juntas."""

import logging
from datetime import date
from unittest.mock import MagicMock

import pytest

from comisionesbi import comisiones_engine, db


def _fila(
    *,
    estado="calculada",
    comisionista_id=None,
    comisionista="JAIME ROJAS",
    sociedad="DBC",
    division="H",
    cedis="Leon 1",
    oficina="0016",
    almacen="H702",
    fecha=date(2026, 7, 1),
    conjunto="HPORTALES",
    tipo="VTA EN RUTA",
    base="kg",
    lineas=1,
    monto=1000.0,
    cantidad=100.0,
    comision=40.0,
    cobrada=0.0,
    monto_cobrado=0.0,
    cmin=None,
    cmax=None,
    sin_importe=0,
):
    # Sin `comisionista_id` explícito, se usa el texto como si fuera la llave
    # -- válido en casi todos los tests, donde un nombre distinto ya implica
    # persona distinta. Los que quieren probar el caso real (mismo persona_cod,
    # texto distinto entre DBC y PAN) pasan `comisionista_id` a mano.
    if comisionista_id is None:
        comisionista_id = comisionista
    return {
        "fecha": fecha,
        "sociedad": sociedad,
        "division_code": division,
        "division": {"H": "Huevo", "BO": "Botana", "L": "Leche"}.get(division, division),
        "cedis": cedis,
        "oficina": oficina,
        "almacen": almacen,
        "comisionista_id": comisionista_id,
        "comisionista": comisionista,
        "tipo_venta": tipo,
        "set": conjunto,
        "base_unidad": base,
        "comision_estado": estado,
        "num_lineas": lineas,
        "monto_total": monto,
        "cantidad_base_total": cantidad,
        "comision_total": comision,
        "comision_min_total": cmin,
        "comision_max_total": cmax,
        "comision_cobrada": cobrada,
        "monto_cobrado": monto_cobrado,
        "lineas_sin_importe": sin_importe,
    }


class _ClienteFalso:
    def __init__(self, detalle):
        self.detalle = detalle
        self.llamadas = []

    def query(self, sql, job_config=None):
        self.llamadas.append((sql, job_config))
        filas = [{"desde": date(2026, 1, 1), "hasta": date(2026, 8, 23)}] if "MIN(fecha)" in sql else self.detalle
        resultado = MagicMock()
        resultado.result.return_value = filas
        return resultado


@pytest.fixture
def cliente(monkeypatch):
    def _instalar(detalle):
        falso = _ClienteFalso(detalle)
        monkeypatch.setattr(db, "get_bq_client", lambda: falso)
        return falso

    return _instalar


@pytest.fixture(autouse=True)
def _cache_desactivada(monkeypatch):
    """`build_report` cachea por combinación de filtros -- casi todos los
    tests de aquí llaman con los mismos parámetros por defecto (`_informe`),
    así que sin esto el segundo test heredaría el resultado del primero. Los
    tests de la caché en sí la reactivan explícitamente."""
    monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", "0")
    comisiones_engine.invalidate_report_cache()
    yield
    comisiones_engine.invalidate_report_cache()


def _informe(**extra):
    parametros = {
        "division": None,
        "cedis": None,
        "start_date": date(2026, 1, 1),
        "end_date": date(2026, 8, 31),
    }
    parametros.update(extra)
    return comisiones_engine.build_report(**parametros)


# ─── Lo que se devenga ────────────────────────────────────────────────────

def test_suma_la_comision_por_comisionista(cliente):
    cliente(
        [
            _fila(comisionista="JAIME ROJAS", comision=40.0, monto=1000.0),
            _fila(comisionista="JAIME ROJAS", comision=10.0, monto=200.0),
            _fila(comisionista="JOSE CAMPOS", comision=25.0, monto=600.0),
        ]
    )

    por = {f["comisionista"]: f for f in _informe()["por_comisionista"]}

    assert por["JAIME ROJAS"]["comision"] == 50.0
    assert por["JAIME ROJAS"]["monto"] == 1200.0
    assert por["JOSE CAMPOS"]["comision"] == 25.0


def test_los_comisionistas_salen_ordenados_por_lo_que_se_les_debe(cliente):
    # Alfabético sería más "ordenado" y menos útil: quien abre esta pantalla
    # pregunta a quién hay que pagarle más, no quién empieza por A.
    cliente(
        [
            _fila(comisionista="ANA", comision=10.0),
            _fila(comisionista="ZOE", comision=90.0),
            _fila(comisionista="LUIS", comision=50.0),
        ]
    )

    nombres = [f["comisionista"] for f in _informe()["por_comisionista"]]

    assert nombres == ["ZOE", "LUIS", "ANA"]


def test_el_comisionista_sin_nombre_va_al_final(cliente):
    cliente([_fila(comisionista=None, comision=999.0), _fila(comisionista="ANA", comision=1.0)])

    assert [f["comisionista"] for f in _informe()["por_comisionista"]] == ["ANA", None]


def test_mismo_comisionista_con_grafia_distinta_por_sociedad_no_se_duplica(cliente):
    # El mismo persona_cod llega con texto distinto desde el Excel de DBC y el
    # de PAN (ver v1_comision_dbc_gold_v2.sql) -- agrupar por `comisionista_id`
    # en vez de por texto evita que la misma persona salga partida en dos filas.
    cliente(
        [
            _fila(comisionista_id="0000014718", comisionista="AGUSTIN JAIMES MENDOZA",
                  sociedad="DBC", comision=10.0, monto=100.0),
            _fila(comisionista_id="0000014718", comisionista="AGUSTIN JAIMES",
                  sociedad="PAN", comision=20.0, monto=200.0),
        ]
    )

    por = _informe()["por_comisionista"]

    assert len(por) == 1
    assert por[0]["comision"] == 30.0
    # El nombre mostrado es el de la primera fila que trajo texto -- lo que
    # importa aquí es que no haya dos filas, no cuál grafía "gana".
    assert por[0]["comisionista"] in {"AGUSTIN JAIMES MENDOZA", "AGUSTIN JAIMES"}


# ─── Lo que NO se devenga, que es la otra mitad ───────────────────────────

def test_lo_bloqueado_viaja_junto_al_total_y_no_se_pierde(cliente):
    cliente(
        [
            _fila(estado="calculada", monto=1000.0, comision=40.0),
            _fila(estado="material sin SET", monto=300.0, comision=None),
            _fila(estado="la división no tarifa ese tipo de venta", monto=700.0, comision=None),
        ]
    )

    salida = _informe()
    motivos = {b["motivo"]: b for b in salida["bloqueado"]}

    # El importe total incluye lo bloqueado: es facturación real, no desaparece.
    assert salida["totales"]["monto"] == 2000.0
    assert salida["totales"]["comision"] == 40.0
    # Y se puede decir exactamente cuánto no se pudo calcular, y por qué.
    assert motivos["la división no tarifa ese tipo de venta"]["monto"] == 700.0
    assert motivos["material sin SET"]["monto"] == 300.0
    assert sum(b["monto"] for b in salida["bloqueado"]) == 1000.0


def test_pct_calculable_dice_sobre_cuanto_se_calculo(cliente):
    # Sin este número, un total bajo por tener poca venta es indistinguible de
    # un total bajo por tener media venta bloqueada.
    cliente(
        [
            _fila(estado="calculada", monto=400.0, comision=16.0),
            _fila(estado="material sin SET", monto=600.0, comision=None),
        ]
    )

    totales = _informe()["totales"]

    assert totales["monto_calculable"] == 400.0
    assert totales["pct_calculable"] == pytest.approx(40.0)


def test_lo_bloqueado_va_ordenado_por_lo_que_rinde_desbloquearlo(cliente):
    cliente(
        [
            _fila(estado="material sin SET", monto=100.0, comision=None),
            _fila(estado="la división no tarifa ese tipo de venta", monto=900.0, comision=None),
            _fila(estado="no hay tarifa para esa oficina", monto=500.0, comision=None),
        ]
    )

    motivos = [b["motivo"] for b in _informe()["bloqueado"]]

    assert motivos[0] == "la división no tarifa ese tipo de venta"
    assert motivos[-1] == "material sin SET"


def test_bloqueado_desglose_agrupa_por_motivo_y_llave_de_tarifa(cliente):
    # La llave de tarifa: sociedad + división + oficina + SET + tipo de venta.
    # Dos líneas con la misma llave se suman; una llave distinta es otra fila.
    cliente(
        [
            _fila(estado="sin tarifa para esa llave", sociedad="PAN", division="H",
                  oficina="0028", conjunto="HPORTALES", tipo="VTA EN RUTA", monto=300.0, comision=None),
            _fila(estado="sin tarifa para esa llave", sociedad="PAN", division="H",
                  oficina="0028", conjunto="HPORTALES", tipo="VTA EN RUTA", monto=200.0, comision=None),
            _fila(estado="sin tarifa para esa llave", sociedad="DBC", division="BO",
                  oficina="0130", conjunto="CHOCOLATE", tipo="MED MAYOREO", monto=100.0, comision=None),
        ]
    )

    desglose = _informe()["bloqueado_desglose"]

    assert len(desglose) == 2
    mayor = desglose[0]
    assert mayor["motivo"] == "sin tarifa para esa llave"
    assert mayor["sociedad"] == "PAN"
    assert mayor["division_code"] == "H"
    assert mayor["division"] == "Huevo"
    assert mayor["oficina"] == "0028"
    assert mayor["almacen"] == "H702"
    assert mayor["set"] == "HPORTALES"
    assert mayor["tipo_venta"] == "VTA EN RUTA"
    assert mayor["monto"] == 500.0
    assert mayor["num_lineas"] == 2


def test_bloqueado_desglose_agrupa_sin_cedis_por_almacen(cliente):
    # "sin CEDIS/tipo de venta" se resuelve por almacén+oficina, no por
    # SET+tipo de venta (que ahí justo falta) -- el almacén tiene que
    # distinguir dos llaves aunque el resto coincida.
    cliente(
        [
            _fila(estado="sin CEDIS/tipo de venta", division="BO", oficina="0188",
                  almacen="BO43", tipo=None, monto=9_520_000.0, comision=None),
            _fila(estado="sin CEDIS/tipo de venta", division="L", oficina="0153",
                  almacen="H735", tipo=None, monto=90_000.0, comision=None),
        ]
    )

    desglose = _informe()["bloqueado_desglose"]

    assert len(desglose) == 2
    assert desglose[0]["almacen"] == "BO43"
    assert desglose[0]["oficina"] == "0188"
    assert desglose[0]["tipo_venta"] is None
    assert desglose[1]["almacen"] == "H735"


def test_bloqueado_desglose_no_incluye_lo_ya_calculado(cliente):
    cliente(
        [
            _fila(estado="calculada", monto=1000.0, comision=40.0),
            _fila(estado="sin tarifa para esa llave", monto=300.0, comision=None),
        ]
    )

    desglose = _informe()["bloqueado_desglose"]

    assert len(desglose) == 1
    assert desglose[0]["motivo"] == "sin tarifa para esa llave"


def test_bloqueado_desglose_separa_motivos_distintos_aunque_la_llave_coincida(cliente):
    cliente(
        [
            _fila(estado="material sin SET", oficina="0028", conjunto="HPORTALES",
                  tipo="VTA EN RUTA", monto=300.0, comision=None),
            _fila(estado="sin tarifa para esa llave", oficina="0028", conjunto="HPORTALES",
                  tipo="VTA EN RUTA", monto=700.0, comision=None),
        ]
    )

    desglose = _informe()["bloqueado_desglose"]

    assert len(desglose) == 2
    assert {d["motivo"] for d in desglose} == {"material sin SET", "sin tarifa para esa llave"}


def test_bloqueado_desglose_ordenado_por_monto_descendente(cliente):
    cliente(
        [
            _fila(estado="sin tarifa para esa llave", oficina="0028", monto=100.0, comision=None),
            _fila(estado="sin tarifa para esa llave", oficina="0106", monto=900.0, comision=None),
        ]
    )

    oficinas = [d["oficina"] for d in _informe()["bloqueado_desglose"]]

    assert oficinas == ["0106", "0028"]


def test_la_horquilla_del_conflicto_no_se_convierte_en_una_cifra(cliente):
    # Donde las dos hojas del cliente se contradicen no hay comisión, hay un
    # rango. Inventar un número aquí es el error caro de todo el módulo.
    cliente(
        [_fila(estado="tarifa en conflicto entre hojas", monto=500.0, comision=None, cmin=15.0, cmax=35.0)]
    )

    salida = _informe()
    conflicto = salida["bloqueado"][0]

    assert salida["totales"]["comision"] == 0.0
    assert conflicto["comision_min"] == 15.0
    assert conflicto["comision_max"] == 35.0


# ─── Las trampas de las unidades y del cobro ──────────────────────────────

def test_la_cantidad_no_se_suma_entre_kilos_y_cajas(cliente):
    # Huevo se comisiona por kilo y el resto por caja. Un total único de
    # "cantidad" sumaría kilos con cajas y no significaría nada.
    cliente(
        [
            _fila(division="H", base="kg", cantidad=100.0),
            _fila(division="L", base="caja", cantidad=7.0),
            _fila(division="H", base="kg", cantidad=50.0),
        ]
    )

    por_unidad = {u["base_unidad"]: u["cantidad"] for u in _informe()["cantidad_por_unidad"]}

    assert por_unidad == {"kg": 150.0, "caja": 7.0}
    assert "cantidad" not in _informe()["totales"]


def test_lo_que_tiene_cobro_registrado_va_aparte_y_no_se_llama_pagable(cliente):
    # La fuente de cobro (sap_bsad_cleared_items) no ve el 100% del facturado,
    # así que esto es el suelo conocido, no lo que hay que pagar.
    cliente([_fila(comision=40.0, cobrada=12.0)])

    totales = _informe()["totales"]

    assert totales["comision"] == 40.0
    assert totales["comision_con_cobro"] == 12.0
    assert "comision_pagable" not in totales


def test_monto_cobrado_se_suma_igual_que_su_comision(cliente):
    # Lado facturado de `comision_con_cobro` (2026-09-09): ya se traía de SQL
    # pero nunca se sumaba en el acumulador -- se propaga solo a todos los
    # agrupados (por_comisionista, desglose, etc.) porque todos pasan por el
    # mismo `_nuevo()`/`_acumular()`.
    cliente(
        [
            _fila(comisionista="ANA", monto=1000.0, monto_cobrado=300.0),
            _fila(comisionista="ANA", monto=500.0, monto_cobrado=200.0),
        ]
    )

    totales = _informe()["totales"]
    ana = next(f for f in _informe()["por_comisionista"] if f["comisionista"] == "ANA")

    assert totales["monto_cobrado"] == 500.0
    assert ana["monto_cobrado"] == 500.0


def test_cuenta_las_lineas_sin_importe(cliente):
    cliente([_fila(sin_importe=3), _fila(sin_importe=5)])

    assert _informe()["totales"]["lineas_sin_importe"] == 8


# ─── Contrato con la pantalla ─────────────────────────────────────────────

def test_la_division_viaja_con_su_nombre_y_su_codigo(cliente):
    cliente([_fila(division="H"), _fila(division="BO", comision=5.0)])

    filas = {f["division_code"]: f for f in _informe()["por_division"]}

    assert filas["H"]["division"] == "Huevo"
    assert filas["BO"]["division"] == "Botana"


def test_la_serie_por_fecha_va_en_orden_cronologico(cliente):
    cliente(
        [
            _fila(fecha=date(2026, 7, 3), comision=3.0),
            _fila(fecha=date(2026, 7, 1), comision=1.0),
            _fila(fecha=date(2026, 7, 2), comision=2.0),
        ]
    )

    fechas = [f["fecha"] for f in _informe()["por_fecha"]]

    assert fechas == ["2026-07-01", "2026-07-02", "2026-07-03"]


def test_agrupa_por_tipo_de_venta(cliente):
    # El objetivo del proyecto pide la comisión "según tipo de venta", y el tipo
    # ya venía en el grano de la tabla gold sin que nadie lo agregara.
    cliente(
        [
            _fila(tipo="VTA EN RUTA", comision=40.0),
            _fila(tipo="VTA EN RUTA", comision=10.0),
            _fila(tipo="MAYOREO", comision=70.0),
        ]
    )

    por = _informe()["por_tipo_venta"]

    # Ordenado por comisión, como el resto de agrupaciones: primero lo que más pesa.
    assert [f["tipo_venta"] for f in por] == ["MAYOREO", "VTA EN RUTA"]
    assert por[1]["comision"] == 50.0


def test_el_tipo_de_venta_sin_resolver_no_se_confunde_con_una_categoria(cliente):
    # `None` significa "esta línea no trae tipo", no un tipo llamado "ninguno":
    # va al final y con la clave a null, para que la pantalla pueda pintarlo
    # aparte en vez de sumarlo a MAYOREO.
    cliente([_fila(tipo=None, comision=5.0), _fila(tipo="MAYOREO", comision=70.0)])

    por = _informe()["por_tipo_venta"]

    assert [f["tipo_venta"] for f in por] == ["MAYOREO", None]


# ─── El desglose de la cascada ────────────────────────────────────────────

def test_el_desglose_llega_al_grano_de_la_tarifa(cliente):
    # Una fila por llave de tarifa (división + oficina + SET + tipo de venta):
    # es el único nivel que se puede cuadrar contra la hoja del cliente.
    cliente(
        [
            _fila(conjunto="HPORTALES", comision=40.0, cantidad=100.0),
            _fila(conjunto="HPORTALES", comision=10.0, cantidad=25.0),
            _fila(conjunto="HSANJUAN", comision=70.0, cantidad=200.0),
        ]
    )

    desglose = _informe()["desglose"]

    assert len(desglose) == 2
    primero = desglose[0]
    assert primero["set"] == "HSANJUAN"
    assert primero["comision"] == 70.0
    # Las columnas de la hoja: la oficina es lo que hace verificable la tarifa.
    assert primero["oficina"] == "0016"
    assert primero["tipo_venta"] == "VTA EN RUTA"
    assert primero["base_unidad"] == "kg"
    # Y la cantidad se acumula, que es lo que multiplica la tarifa.
    assert desglose[1]["cantidad_base"] == 125.0


def test_el_desglose_no_parte_la_hoja_por_estado_pero_dice_cuanto_se_calculo(cliente):
    # Partirla dejaría dos filas para la misma llave de tarifa, una calculada y
    # otra bloqueada, y nadie sabría que son la misma cosa. Va una fila, y
    # dentro `monto_calculable` dice cuánto de ella llegó a tener tarifa.
    cliente(
        [
            _fila(monto=1000.0, comision=40.0),
            _fila(monto=600.0, comision=0.0, estado="tarifa en conflicto entre hojas"),
        ]
    )

    desglose = _informe()["desglose"]

    assert len(desglose) == 1
    assert desglose[0]["monto"] == 1600.0
    assert desglose[0]["monto_calculable"] == 1000.0


def test_el_desglose_separa_las_unidades_para_no_sumar_kilos_con_cajas(cliente):
    cliente(
        [
            _fila(division="H", base="kg", cantidad=100.0, comision=40.0),
            _fila(division="BO", base="caja", cantidad=7.0, comision=10.0),
        ]
    )

    por_unidad = {f["base_unidad"]: f["cantidad_base"] for f in _informe()["desglose"]}

    assert por_unidad == {"kg": 100.0, "caja": 7.0}


def test_el_desglose_se_niega_a_agrupar_sin_la_unidad_en_la_llave(cliente):
    # Es la comprobación que evita el número que parece una cantidad y no lo es.
    cliente([_fila()])
    filas = [_fila()]

    with pytest.raises(ValueError, match="base_unidad"):
        comisiones_engine._desglose(filas, ("comisionista", "set"))


def test_los_filtros_viajan_como_parametros_y_no_pegados_al_sql(cliente):
    falso = cliente([_fila()])

    _informe(division="H", cedis="Leon 1", comisionista_id="0000014718")

    _, config = falso.llamadas[0]
    valores = {p.name: p.value for p in config.query_parameters}
    assert valores["division"] == "H"
    assert valores["comisionista_id"] == "0000014718"
    assert "0000014718" not in falso.llamadas[0][0]


def test_un_rango_sin_datos_devuelve_estructura_vacia_pero_con_cobertura(cliente):
    cliente([])

    salida = _informe()

    assert salida["totales"]["comision"] == 0.0
    assert salida["totales"]["pct_calculable"] == 0.0
    assert salida["por_comisionista"] == []
    assert salida["por_tipo_venta"] == []
    assert salida["bloqueado"] == []


# ─── Caché del informe ─────────────────────────────────────────────────────
# Mismo mecanismo que catalog_engine (ver test_catalog_engine.py para el
# porqué de cada caso) -- aquí solo lo que cambia por tener llave compuesta.


@pytest.fixture
def reloj(monkeypatch):
    """Reloj monotónico fijo y avanzable, para no dormir en los tests del TTL."""
    actual = [1000.0]
    monkeypatch.setattr(comisiones_engine, "_now", lambda: actual[0])
    return actual


def _activar_cache(monkeypatch, segundos="14400"):
    monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", segundos)


def test_la_segunda_peticion_con_los_mismos_filtros_no_vuelve_a_consultar(cliente, monkeypatch, reloj):
    _activar_cache(monkeypatch)
    falso = cliente([_fila(comision=40.0)])

    primero = _informe()
    segundo = _informe()

    # cobertura() no cachea, así que hay 2 llamadas por informe: MIN(fecha) y
    # el detalle. Dos informes cacheados -> 2 llamadas en total, no 4.
    assert len(falso.llamadas) == 2
    assert segundo == primero


def test_filtros_distintos_son_entradas_de_cache_distintas(cliente, monkeypatch, reloj):
    _activar_cache(monkeypatch)
    falso = cliente([_fila(comision=40.0)])

    _informe(division="H")
    _informe(division="BO")

    # Dos combinaciones de filtro distintas -> cada una consulta la suya.
    assert len(falso.llamadas) == 4


def test_al_vencer_el_ttl_vuelve_a_consultar(cliente, monkeypatch, reloj):
    _activar_cache(monkeypatch, "3600")
    falso = cliente([_fila(comision=40.0)])

    _informe()
    reloj[0] += 3599
    _informe()
    assert len(falso.llamadas) == 2

    reloj[0] += 2  # ya pasó la hora
    _informe()
    assert len(falso.llamadas) == 4


def test_ttl_cero_desactiva_la_cache(cliente, monkeypatch, reloj):
    _activar_cache(monkeypatch, "0")
    falso = cliente([_fila(comision=40.0)])

    _informe()
    _informe()

    assert len(falso.llamadas) == 4


def test_ttl_ilegible_cae_al_valor_por_defecto(monkeypatch):
    monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", "cuatro-horas")
    assert comisiones_engine._report_cache_ttl_seconds() == 4 * 3600

    monkeypatch.delenv("REPORT_CACHE_TTL_SECONDS")
    assert comisiones_engine._report_cache_ttl_seconds() == 4 * 3600

    monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", "-5")
    assert comisiones_engine._report_cache_ttl_seconds() == 0


def test_si_bigquery_falla_se_sirve_la_copia_caducada(cliente, monkeypatch, reloj, caplog):
    _activar_cache(monkeypatch, "3600")
    falso = cliente([_fila(comision=40.0)])
    bueno = _informe()

    reloj[0] += 4000  # caducada

    class _ClienteCaido:
        def query(self, sql, job_config=None):
            from google.api_core.exceptions import ServiceUnavailable

            raise ServiceUnavailable("caído")

    monkeypatch.setattr(db, "get_bq_client", lambda: _ClienteCaido())

    with caplog.at_level(logging.WARNING):
        assert _informe() == bueno

    assert "copia caducada" in caplog.text


def test_invalidate_report_cache_fuerza_la_relectura(cliente, monkeypatch, reloj):
    _activar_cache(monkeypatch)
    falso = cliente([_fila(comision=40.0)])

    _informe()
    comisiones_engine.invalidate_report_cache()
    _informe()

    assert len(falso.llamadas) == 4


def test_separa_la_comision_por_sociedad(cliente):
    # Huevo se factura por DBC y por PAN, y la de PAN es la mayor parte del
    # total. Sumarlas sin poder separarlas mezcla dos negocios distintos.
    cliente(
        [
            _fila(sociedad="DBC", division="H", comision=12.0, monto=330.0),
            _fila(sociedad="PAN", division="H", comision=62.0, monto=2100.0),
            _fila(sociedad="DBC", division="BO", comision=24.0, monto=246.0),
        ]
    )

    por = {f["sociedad"]: f for f in _informe()["por_sociedad"]}

    assert por["PAN"]["comision"] == 62.0
    assert por["DBC"]["comision"] == 36.0
    # Y el total sigue siendo la suma de las dos, no una de ellas.
    assert _informe()["totales"]["comision"] == 98.0
