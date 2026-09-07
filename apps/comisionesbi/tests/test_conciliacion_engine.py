"""Conciliación: el detalle por producto que hoy se arma a mano, por comisionista."""

from datetime import date
from unittest.mock import MagicMock

import pytest

from comisionesbi import conciliacion_engine, db


def _fila(
    *,
    semana=date(2026, 8, 29),
    periodo_fin=date(2026, 9, 4),
    comisionista="EDGARDO TRUJILLO",
    division="IA",
    cedis="Leon 1",
    oficina="0023",
    tipo="VTA EN RUTA",
    matnr="110000020731",
    descripcion="CHOP ADULTO 25Kg",
    unidad_venta="saco",
    unidad_tarifa="kg",
    tarifa=2.5,
    lineas=1,
    cantidad_venta=28.0,
    monto=17982.72,
    cantidad_base=700.0,
    comision=1750.0,
    sin_comision=0,
):
    return {
        "semana": semana,
        "periodo_fin": periodo_fin,
        "division_code": division,
        "division": {"IA": "Alimento", "H": "Huevo", "BO": "Botana"}.get(division, division),
        "cedis": cedis,
        "oficina": oficina,
        "comisionista": comisionista,
        "tipo_venta": tipo,
        "matnr": matnr,
        "descripcion": descripcion,
        "unidad_venta": unidad_venta,
        "unidad_tarifa": unidad_tarifa,
        "tarifa": tarifa,
        "num_lineas": lineas,
        "cantidad_venta_total": cantidad_venta,
        "monto_total": monto,
        "cantidad_base_total": cantidad_base,
        "comision_total": comision,
        "lineas_sin_comision": sin_comision,
    }


class _ClienteFalso:
    def __init__(self, detalle):
        self.detalle = detalle
        self.llamadas = []

    def query(self, sql, job_config=None):
        self.llamadas.append((sql, job_config))
        filas = [{"desde": date(2026, 1, 3), "hasta": date(2026, 8, 29)}] if "MIN(semana)" in sql else self.detalle
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
        "comisionista": None,
        "start_date": date(2026, 8, 1),
        "end_date": date(2026, 8, 31),
    }
    parametros.update(extra)
    return conciliacion_engine.build_conciliacion(**parametros)


# ─── Nivel 1: a quién hay que pagarle ──────────────────────────────────────


def test_suma_por_comisionista_y_division(cliente):
    cliente(
        [
            _fila(comisionista="EDGARDO TRUJILLO", division="IA", comision=1750.0, monto=17982.72),
            _fila(comisionista="EDGARDO TRUJILLO", division="IA", comision=1645.0, monto=16612.15, matnr="X"),
            _fila(comisionista="NOEL GARCIA", division="IA", comision=980.0, monto=10379.32),
        ]
    )

    por = {f["comisionista"]: f for f in _informe()["por_comisionista"]}

    assert por["EDGARDO TRUJILLO"]["comision_total"] == pytest.approx(3395.0)
    assert por["EDGARDO TRUJILLO"]["monto_total"] == pytest.approx(34594.87)
    assert por["NOEL GARCIA"]["comision_total"] == 980.0


def test_ordena_alfabetico_por_comisionista_y_nulos_al_final(cliente):
    # A diferencia de comisiones_engine (que ordena por lo que se debe pagar),
    # aquí se busca a una persona concreta en la lista -- alfabético es lo que
    # sirve para eso.
    cliente(
        [
            _fila(comisionista="ZOE", comision=90.0),
            _fila(comisionista=None, comision=999.0),
            _fila(comisionista="ANA", comision=10.0),
        ]
    )

    nombres = [f["comisionista"] for f in _informe()["por_comisionista"]]

    assert nombres == ["ANA", "ZOE", None]


def test_dentro_del_mismo_comisionista_ordena_por_division(cliente):
    cliente(
        [
            _fila(comisionista="FLORENTINO GLEZ", division="L", comision=1.0),
            _fila(comisionista="FLORENTINO GLEZ", division="H", comision=2.0),
            _fila(comisionista="FLORENTINO GLEZ", division="IA", comision=3.0),
        ]
    )

    divisiones = [f["division_code"] for f in _informe()["por_comisionista"]]

    assert divisiones == ["H", "IA", "L"]


def test_misma_persona_en_dos_divisiones_no_se_mezcla(cliente):
    # Florentino cobra por separado en cada división -- una fila por
    # (comisionista, division_code), no una sola bolsa con todo junto.
    cliente(
        [
            _fila(comisionista="FLORENTINO GLEZ", division="IA", comision=100.0),
            _fila(comisionista="FLORENTINO GLEZ", division="H", comision=50.0),
        ]
    )

    filas = _informe()["por_comisionista"]

    assert len(filas) == 2
    assert {f["division_code"] for f in filas} == {"IA", "H"}


def test_la_division_viaja_con_su_nombre(cliente):
    cliente([_fila(division="IA", comision=1.0)])

    fila = _informe()["por_comisionista"][0]

    assert fila["division"] == "Alimento"


def test_cuenta_las_semanas_distintas_del_comisionista(cliente):
    cliente(
        [
            _fila(comisionista="ANA", semana=date(2026, 8, 22), comision=10.0),
            _fila(comisionista="ANA", semana=date(2026, 8, 29), comision=20.0),
        ]
    )

    assert _informe()["por_comisionista"][0]["num_semanas"] == 2


def test_cuenta_las_lineas_sin_comision(cliente):
    cliente([_fila(sin_comision=2), _fila(sin_comision=3, matnr="Y")])

    total = sum(f["lineas_sin_comision"] for f in _informe()["por_comisionista"])

    assert total == 5


# ─── Nivel 2/3: el detalle que arma la cascada y la tabla de producto ─────


def test_el_detalle_trae_una_fila_por_producto_sin_agregar(cliente):
    # A diferencia de comisiones_engine, aquí el backend no pre-agrega la
    # cascada: filtrado a un comisionista y unas semanas son decenas de filas,
    # así que se arma en el frontend agrupando el detalle en memoria.
    cliente(
        [
            _fila(matnr="A1", descripcion="CHOP ADULTO 25Kg", comision=1750.0),
            _fila(matnr="A2", descripcion="BALTO ADULTO 20 K", comision=1645.0),
        ]
    )

    detalle = _informe()["detalle"]

    assert len(detalle) == 2
    assert {d["descripcion"] for d in detalle} == {"CHOP ADULTO 25Kg", "BALTO ADULTO 20 K"}
    assert detalle[0]["semana"] == "2026-08-29"


def test_el_detalle_conserva_cedis_oficina_y_tipo_de_venta(cliente):
    cliente([_fila(cedis="Leon 1", oficina="0023", tipo="VTA EN RUTA")])

    fila = _informe()["detalle"][0]

    assert fila["cedis"] == "Leon 1"
    assert fila["oficina"] == "0023"
    assert fila["tipo_venta"] == "VTA EN RUTA"


def test_el_detalle_trae_la_aritmetica_completa_del_producto(cliente):
    # cantidad_venta (nativa) + unidad, y cantidad_base + tarifa -> comisión:
    # las mismas columnas que ella escribe a mano.
    cliente([_fila(cantidad_venta=28.0, unidad_venta="saco", cantidad_base=700.0, tarifa=2.5, comision=1750.0)])

    fila = _informe()["detalle"][0]

    assert fila["cantidad_venta_total"] == 28.0
    assert fila["unidad_venta"] == "saco"
    assert fila["cantidad_base_total"] == 700.0
    assert fila["tarifa"] == 2.5
    assert fila["comision_total"] == 1750.0


# ─── Filtros y cobertura ───────────────────────────────────────────────────


def test_los_filtros_viajan_como_parametros_y_no_pegados_al_sql(cliente):
    falso = cliente([_fila()])

    _informe(division="IA", comisionista="EDGARDO TRUJILLO")

    _, config = falso.llamadas[0]
    valores = {p.name: p.value for p in config.query_parameters}
    assert valores["division"] == "IA"
    assert valores["comisionista"] == "EDGARDO TRUJILLO"
    assert "EDGARDO TRUJILLO" not in falso.llamadas[0][0]


def test_un_rango_sin_datos_devuelve_estructura_vacia_pero_con_cobertura(cliente):
    cliente([])

    salida = _informe()

    assert salida["por_comisionista"] == []
    assert salida["detalle"] == []
    assert salida["cobertura"]["hasta"] == "2026-08-29"


# ─── Detalle diario (transparencia del corte de mes) ──────────────────────


def _fila_diaria(**extra):
    fila = _fila(**{k: v for k, v in extra.items() if k != "fecha"})
    fila["fecha"] = extra.get("fecha", date(2026, 4, 25))
    del fila["semana"]
    del fila["periodo_fin"]
    return fila


def test_detalle_diario_trae_una_fila_por_dia_sin_agregar_por_periodo(cliente):
    # Es justo lo que arregla: el periodo agregado (25 abril - 8 mayo, con el
    # supuesto de corte de mes) se puede desarmar día por día para verificarlo.
    cliente(
        [
            _fila_diaria(fecha=date(2026, 4, 25), comision=300.0),
            _fila_diaria(fecha=date(2026, 4, 30), comision=300.0),
            _fila_diaria(fecha=date(2026, 5, 1), comision=300.0),
        ]
    )

    filas = conciliacion_engine.detalle_diario(
        division=None, comisionista="EDGARDO TRUJILLO", start_date=date(2026, 4, 25), end_date=date(2026, 5, 1)
    )

    assert [f["fecha"] for f in filas] == ["2026-04-25", "2026-04-30", "2026-05-01"]


def test_detalle_diario_pasa_los_filtros_como_parametros(cliente):
    falso = cliente([_fila_diaria()])

    conciliacion_engine.detalle_diario(
        division="IA", comisionista="EDGARDO TRUJILLO", start_date=date(2026, 4, 25), end_date=date(2026, 5, 1)
    )

    _, config = falso.llamadas[0]
    valores = {p.name: p.value for p in config.query_parameters}
    assert valores["division"] == "IA"
    assert valores["comisionista"] == "EDGARDO TRUJILLO"


# ─── Detalle de factura (trazabilidad máxima, con cobro) ──────────────────


def _fila_factura(*, billing_document="2071163278", item_number="1", fecha=date(2026, 4, 25), se_cobro=False,
                   monto_cobrado=None, cantidad_cobrada=None, comision_cobrada=None, fecha_cobro=None, **extra):
    fila = _fila(**{k: v for k, v in extra.items() if k not in ("fecha", "semana")})
    del fila["semana"]
    del fila["periodo_fin"]
    fila.update(
        billing_document=billing_document,
        item_number=item_number,
        fecha=fecha,
        se_cobro=se_cobro,
        monto_cobrado=monto_cobrado,
        cantidad_cobrada=cantidad_cobrada,
        comision_cobrada=comision_cobrada,
        fecha_cobro=fecha_cobro,
    )
    return fila


def test_detalle_factura_trae_billing_document_e_item_number(cliente):
    cliente([_fila_factura(billing_document="2071163278", item_number="1")])

    filas = conciliacion_engine.detalle_factura(
        division=None, comisionista="EDGARDO TRUJILLO", start_date=date(2026, 4, 25), end_date=date(2026, 5, 1)
    )

    assert filas[0]["billing_document"] == "2071163278"
    assert filas[0]["item_number"] == "1"


def test_detalle_factura_trae_cobro_por_linea(cliente):
    # A diferencia de diario/semanal, esta sí trae cobro -- es la excepción a
    # propósito a "en pausa perseguir cobro".
    cliente(
        [
            _fila_factura(se_cobro=True, monto_cobrado=1000.0, comision_cobrada=40.0, fecha_cobro=date(2026, 5, 5)),
            _fila_factura(billing_document="2071163279", se_cobro=False),
        ]
    )

    filas = conciliacion_engine.detalle_factura(
        division=None, comisionista="EDGARDO TRUJILLO", start_date=date(2026, 4, 25), end_date=date(2026, 5, 1)
    )

    cobrada = next(f for f in filas if f["se_cobro"])
    sin_cobrar = next(f for f in filas if not f["se_cobro"])
    assert cobrada["monto_cobrado"] == 1000.0
    assert cobrada["comision_cobrada"] == 40.0
    assert cobrada["fecha_cobro"] == "2026-05-05"
    assert sin_cobrar["monto_cobrado"] is None
    assert sin_cobrar["fecha_cobro"] is None


def test_detalle_factura_pasa_los_filtros_como_parametros(cliente):
    falso = cliente([_fila_factura()])

    conciliacion_engine.detalle_factura(
        division="IA", comisionista="EDGARDO TRUJILLO", start_date=date(2026, 4, 25), end_date=date(2026, 5, 1)
    )

    _, config = falso.llamadas[0]
    valores = {p.name: p.value for p in config.query_parameters}
    assert valores["division"] == "IA"
    assert valores["comisionista"] == "EDGARDO TRUJILLO"
