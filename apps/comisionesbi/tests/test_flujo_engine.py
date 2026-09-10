"""Flujo de producto: agregación, cobertura y las trampas de las unidades."""

import logging
from datetime import date
from unittest.mock import MagicMock

import pytest
from google.api_core.exceptions import ServiceUnavailable

from comisionesbi import db, flujo_engine
from comisionesbi.db import BigQueryQueryError

COBERTURA = [
    {"fase": "vendido", "desde": date(2026, 1, 1), "hasta": date(2026, 7, 20)},
    {"fase": "facturado", "desde": date(2026, 1, 1), "hasta": date(2026, 8, 13)},
    {"fase": "cobrado", "desde": date(2026, 1, 2), "hasta": date(2026, 8, 12)},
]


def _fila(
    fase,
    fecha,
    cedis,
    monto,
    *,
    division_code="H",
    division="Huevo",
    unidad="CS",
    cantidad=10.0,
    cajas=None,
    lineas=1,
    central=False,
    en_operacion=True,
    sociedad="DBC",
):
    return {
        "fase": fase,
        "sociedad": sociedad,
        "fecha": fecha,
        "division_code": division_code,
        "division": division,
        "cedis": cedis,
        "tipo_venta": "VTA EN RUTA",
        "almacen_central": central,
        "division_en_operacion": en_operacion,
        "unidad": unidad,
        "num_lineas": lineas,
        "cantidad_total": cantidad,
        "cantidad_cajas_total": cajas,
        "monto_total": monto,
    }


class _ClienteFalso:
    """Devuelve filas distintas según qué consulta se le pida, y las registra."""

    def __init__(self, detalle):
        self.detalle = detalle
        self.llamadas = []

    def query(self, sql, job_config=None):
        self.llamadas.append((sql, job_config))
        filas = COBERTURA if "GROUP BY fase" in sql else self.detalle
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


def _flujo(**extra):
    parametros = {
        "division": None,
        "cedis": None,
        "tipo_venta": None,
        "start_date": date(2026, 1, 1),
        "end_date": date(2026, 8, 31),
    }
    parametros.update(extra)
    return flujo_engine.build_flujo(**parametros)


def test_suma_por_fase(cliente):
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0, lineas=3),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 50.5, lineas=2),
            _fila("vendido", date(2026, 7, 1), "Leon 1", 80.0, lineas=1),
        ]
    )

    resumen = {f["fase"]: f for f in _flujo()["resumen"]}

    assert resumen["facturado"]["monto_total"] == 150.5
    assert resumen["facturado"]["num_lineas"] == 5
    assert resumen["vendido"]["monto_total"] == 80.0


def test_las_cajas_solo_suman_donde_existen(cliente):
    # `cantidad_cajas` ya viene en las tres fases, pero una fila puede traerla en
    # None y entonces se queda en None, no en 0: la interfaz debe poder distinguir
    # "cero cajas" de "aquí no aplica esta métrica".
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0, cajas=12.0),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 100.0, cajas=8.0),
            _fila("cobrado", date(2026, 7, 1), "Leon 1", 90.0, cajas=None),
        ]
    )

    resumen = {f["fase"]: f for f in _flujo()["resumen"]}

    assert resumen["facturado"]["cantidad_cajas_total"] == 20.0
    assert resumen["cobrado"]["cantidad_cajas_total"] is None


def test_cantidad_por_unidad_usa_cajas_y_la_unidad_de_manejo_real(cliente):
    # No la cantidad cruda (`cantidad_total`, CS/PZA/PAQ/SAC/KG mezclados) ni
    # el nombre "cajas" a secas: la unidad de manejo real por división
    # (confirmada 2026-09-07), agrupada por división para que Abarrotes y
    # Leche (ambas "pieza") no se confundan entre sí en el detalle.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 10.0, division_code="H", cajas=5.0, cantidad=999.0),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 10.0, division_code="H", cajas=2.0, cantidad=999.0),
            _fila("facturado", date(2026, 7, 3), "Leon 1", 10.0, division_code="A", division="Abarrotes", cajas=300.0),
            _fila("facturado", date(2026, 7, 4), "Leon 1", 10.0, division_code="L", division="Leche", cajas=40.0),
        ]
    )

    resultado = _flujo()

    assert resultado["cantidad_por_unidad"] == [
        {"fase": "facturado", "division_code": "A", "division": "Abarrotes", "unidad": "pieza", "cantidad_total": 300.0},
        {"fase": "facturado", "division_code": "H", "division": "Huevo", "unidad": "caja", "cantidad_total": 7.0},
        {"fase": "facturado", "division_code": "L", "division": "Leche", "unidad": "pieza", "cantidad_total": 40.0},
    ]
    # Y no existe ningún total agregado de cantidad que las mezcle.
    assert "cantidad_total" not in resultado["resumen"][0]


def test_cantidad_por_unidad_ignora_filas_sin_cajas(cliente):
    # Si `cantidad_cajas` viene en None ("aquí no aplica"), la fila no debe
    # aparecer como si fueran cero unidades reales.
    cliente([_fila("facturado", date(2026, 7, 1), "Leon 1", 10.0, cajas=None)])

    assert _flujo()["cantidad_por_unidad"] == []


def test_devuelve_la_fecha_de_corte_de_cada_fase(cliente):
    # Hoy vendido se corta el 20 de julio porque sap_VBAP no tiene datos nuevos
    # (ver data/notas/hallazgos.md). Sin este dato la pantalla pintaría ceros y
    # parecería un desplome de ventas.
    cliente([_fila("facturado", date(2026, 8, 1), "Leon 1", 10.0)])

    cobertura = _flujo()["cobertura"]

    assert cobertura["vendido"]["hasta"] == "2026-07-20"
    assert cobertura["facturado"]["hasta"] == "2026-08-13"
    assert cobertura["cobrado"]["desde"] == "2026-01-02"


def test_la_cobertura_ignora_el_filtro_de_fechas(cliente):
    # "Hasta cuándo hay datos" es propiedad del dataset, no del rango pedido.
    # Si la consulta de cobertura llevara @start/@end siempre devolvería el
    # final del rango y no avisaría de nada.
    falso = cliente([])

    _flujo(start_date=date(2026, 3, 1), end_date=date(2026, 3, 31))

    cobertura_sql = [sql for sql, _ in falso.llamadas if "GROUP BY fase" in sql]
    assert len(cobertura_sql) == 1
    assert "@start" not in cobertura_sql[0]
    assert "@end" not in cobertura_sql[0]


def test_los_filtros_viajan_como_parametros(cliente):
    # Nunca interpolados en el SQL: eso sería una vía de inyección.
    falso = cliente([])

    _flujo(division="H", cedis="Leon 1", start_date=date(2026, 5, 1), end_date=date(2026, 5, 31))

    detalle_sql, job_config = next(
        (sql, cfg) for sql, cfg in falso.llamadas if "GROUP BY fase" not in sql
    )
    assert "Leon 1" not in detalle_sql
    parametros = {p.name: (p.type_, p.value) for p in job_config.query_parameters}
    assert parametros == {
        "start": ("DATE", date(2026, 5, 1)),
        "end": ("DATE", date(2026, 5, 31)),
        "division": ("STRING", "H"),
        "cedis": ("STRING", "Leon 1"),
        "tipo_venta": ("STRING", None),
        "sociedad": ("STRING", None),
    }


def test_un_filtro_vacio_viaja_como_null_tipado(cliente):
    # El SQL usa `(@x IS NULL OR columna = @x)`, así que el parámetro tiene que
    # existir aunque no haya filtro.
    falso = cliente([])

    _flujo(division=None, cedis=None)

    _, job_config = next((sql, cfg) for sql, cfg in falso.llamadas if "GROUP BY fase" not in sql)
    parametros = {p.name: p.value for p in job_config.query_parameters}
    assert parametros["division"] is None
    assert parametros["cedis"] is None


def test_agrupa_por_division_con_su_nombre(cliente):
    # La interfaz enseña "Huevo" y filtra por "H": necesita los dos juntos.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0),
            _fila("facturado", date(2026, 7, 2), "Leon 2", 50.0),
        ]
    )

    divisiones = _flujo()["por_division"]

    assert divisiones == [
        {
            "division_code": "H",
            "fase": "facturado",
            "num_lineas": 2,
            "monto_total": 150.0,
            "cantidad_cajas_total": None,
            "division": "Huevo",
        }
    ]


def test_agrupa_por_tipo_de_venta(cliente):
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 40.0),
        ]
    )

    assert _flujo()["por_tipo_venta"][0]["tipo_venta"] == "VTA EN RUTA"
    assert _flujo()["por_tipo_venta"][0]["monto_total"] == 140.0


def test_agrupa_por_sociedad(cliente):
    # DBC y PAN (2026-09-10): facturado/cobrado ya traen las dos, y la pantalla
    # necesita poder mostrar por qué el total no es el mismo que "vendido"
    # (que siempre es DBC).
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0, sociedad="DBC"),
            _fila("facturado", date(2026, 7, 2), None, 2000.0, sociedad="PAN"),
        ]
    )

    por_sociedad = {f["sociedad"]: f["monto_total"] for f in _flujo()["por_sociedad"]}

    assert por_sociedad == {"DBC": 100.0, "PAN": 2000.0}


def test_la_sociedad_tambien_es_filtrable(cliente):
    falso = cliente([])

    _flujo(sociedad="PAN")

    _, job_config = next((sql, cfg) for sql, cfg in falso.llamadas if "GROUP BY fase" not in sql)
    parametros = {p.name: p.value for p in job_config.query_parameters}
    assert parametros["sociedad"] == "PAN"


def test_los_grupos_sin_valor_van_al_final(cliente):
    # "Sin asignar" es el grupo más grande en importe; si se ordenara con los
    # demás quedaría arriba del todo y taparía a los CEDIS reales.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), None, 900.0),
            _fila("facturado", date(2026, 7, 1), "Leon 1", 10.0),
            _fila("facturado", date(2026, 7, 1), "Ags", 20.0),
        ]
    )

    assert [f["cedis"] for f in _flujo()["por_cedis"]] == ["Ags", "Leon 1", None]


def test_el_tipo_de_venta_tambien_es_filtrable(cliente):
    falso = cliente([])

    _flujo(tipo_venta="MAYOREO")

    _, job_config = next((sql, cfg) for sql, cfg in falso.llamadas if "GROUP BY fase" not in sql)
    parametros = {p.name: p.value for p in job_config.query_parameters}
    assert parametros["tipo_venta"] == "MAYOREO"


def test_agrupa_por_fecha_y_por_cedis(cliente):
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 10.0),
            _fila("facturado", date(2026, 7, 1), "Leon 2", 20.0),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 30.0),
        ]
    )

    resultado = _flujo()

    por_fecha = {(f["fecha"], f["fase"]): f["monto_total"] for f in resultado["por_fecha"]}
    # El día 1 junta los dos CEDIS (10 + 20); el día 2 solo tiene Leon 1.
    assert por_fecha[("2026-07-01", "facturado")] == 30.0
    assert por_fecha[("2026-07-02", "facturado")] == 30.0

    por_cedis = {(f["cedis"], f["fase"]): f["monto_total"] for f in resultado["por_cedis"]}
    assert por_cedis[("Leon 1", "facturado")] == 40.0
    assert por_cedis[("Leon 2", "facturado")] == 20.0


def test_rango_sin_datos_devuelve_estructura_vacia_pero_con_cobertura(cliente):
    cliente([])

    resultado = _flujo(start_date=date(2025, 1, 1), end_date=date(2025, 1, 31))

    assert resultado["resumen"] == []
    assert resultado["por_fecha"] == []
    # La cobertura sigue informando: es lo que explica por qué no hay nada.
    assert resultado["cobertura"]["facturado"]["hasta"] == "2026-08-13"


def test_un_fallo_de_bigquery_se_traduce(monkeypatch, caplog):
    fallo = MagicMock()
    fallo.query.side_effect = ServiceUnavailable("backend error")
    monkeypatch.setattr(db, "get_bq_client", lambda: fallo)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(BigQueryQueryError, match="flujo de producto"):
            _flujo()

    assert any(registro.exc_info for registro in caplog.records)


# ─── El alcance de la pantalla ────────────────────────────────────────────
#
# Estas dos marcas son las que llevaron el importe «sin CEDIS» del 65% al 0,2%,
# así que conviene que estén atadas: la diferencia entre las dos formas de
# quedarse fuera es deliberada y se pierde con solo mirar el código por encima.


def test_las_divisiones_que_dbc_no_opera_no_salen_por_ningun_lado(cliente):
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0),
            _fila("facturado", date(2026, 7, 1), "Leon 1", 900.0, en_operacion=False),
        ]
    )

    salida = _flujo()
    resumen = {f["fase"]: f for f in salida["resumen"]}

    assert resumen["facturado"]["monto_total"] == 100.0
    # Ni en el desglose ni en el contador de excluidos: nunca fueron de esta
    # pantalla, las lleva otro departamento.
    assert salida["excluido_almacen_central"]["monto_total"] == 0.0


def test_los_almacenes_centrales_salen_del_desglose_pero_se_cuentan_aparte(cliente):
    # La diferencia con el caso de arriba: estos SÍ son negocio de DBC, solo que
    # no pasan por ningún CEDIS. Descontarlos en silencio es como se construye
    # un total que nadie puede cuadrar seis meses después.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0, lineas=2),
            _fila("facturado", date(2026, 7, 1), None, 300.0, lineas=6, central=True),
        ]
    )

    salida = _flujo()
    fuera = salida["excluido_almacen_central"]

    assert {f["fase"]: f["monto_total"] for f in salida["resumen"]} == {"facturado": 100.0}
    assert fuera["monto_total"] == 300.0
    assert fuera["num_lineas"] == 6
    assert fuera["pct_del_total"] == pytest.approx(75.0)


def test_lo_excluido_se_mide_sobre_facturado_y_no_sumando_las_tres_fases(cliente):
    # Sumar vendido + facturado + cobrado da un número que no existe: es el
    # mismo producto contado tres veces según avanza por el embudo. La cifra que
    # se enseña tiene que ser la de facturado, que es la contrastable contra SAP.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 100.0),
            _fila("facturado", date(2026, 7, 1), None, 100.0, central=True),
            _fila("vendido", date(2026, 7, 1), None, 5000.0, central=True),
            _fila("cobrado", date(2026, 7, 1), None, 5000.0, central=True),
        ]
    )

    fuera = _flujo()["excluido_almacen_central"]

    assert fuera["monto_total"] == 100.0
    assert fuera["pct_del_total"] == pytest.approx(50.0)


def test_sin_facturado_en_el_periodo_no_se_inventa_una_cifra_de_otra_fase(cliente):
    cliente([_fila("vendido", date(2026, 7, 1), None, 900.0, central=True)])

    fuera = _flujo()["excluido_almacen_central"]

    assert fuera["monto_total"] == 0.0
    assert fuera["pct_del_total"] == 0.0
