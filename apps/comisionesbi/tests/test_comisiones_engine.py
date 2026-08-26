"""Comisión: lo devengado, lo bloqueado, y que las dos cosas viajen juntas."""

from datetime import date
from unittest.mock import MagicMock

import pytest

from comisionesbi import comisiones_engine, db


def _fila(
    *,
    estado="calculada",
    comisionista="JAIME ROJAS",
    division="H",
    cedis="Leon 1",
    fecha=date(2026, 7, 1),
    conjunto="HPORTALES",
    tipo="VTA EN RUTA",
    base="kg",
    lineas=1,
    monto=1000.0,
    cantidad=100.0,
    comision=40.0,
    cobrada=0.0,
    cmin=None,
    cmax=None,
    sin_importe=0,
):
    return {
        "fecha": fecha,
        "division_code": division,
        "division": {"H": "Huevo", "BO": "Botana", "L": "Leche"}.get(division, division),
        "cedis": cedis,
        "oficina": "0016",
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
        "monto_cobrado": 0.0,
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
    # `sap_pago` solo ve el 27% del facturado, así que esto es el suelo
    # conocido, no lo que hay que pagar.
    cliente([_fila(comision=40.0, cobrada=12.0)])

    totales = _informe()["totales"]

    assert totales["comision"] == 40.0
    assert totales["comision_con_cobro"] == 12.0
    assert "comision_pagable" not in totales


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

    _informe(division="H", cedis="Leon 1", comisionista="JAIME ROJAS")

    _, config = falso.llamadas[0]
    valores = {p.name: p.value for p in config.query_parameters}
    assert valores["division"] == "H"
    assert valores["comisionista"] == "JAIME ROJAS"
    assert "JAIME ROJAS" not in falso.llamadas[0][0]


def test_un_rango_sin_datos_devuelve_estructura_vacia_pero_con_cobertura(cliente):
    cliente([])

    salida = _informe()

    assert salida["totales"]["comision"] == 0.0
    assert salida["totales"]["pct_calculable"] == 0.0
    assert salida["por_comisionista"] == []
    assert salida["por_tipo_venta"] == []
    assert salida["bloqueado"] == []
    # La cobertura es del dataset, no del rango: sigue estando.
    assert salida["cobertura"]["hasta"] == "2026-08-23"
