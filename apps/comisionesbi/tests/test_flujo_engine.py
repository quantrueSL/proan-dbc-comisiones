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


def _fila(fase, fecha, cedis, monto, *, unidad="CS", cantidad=10.0, cajas=None, lineas=1):
    return {
        "fase": fase,
        "fecha": fecha,
        "division_code": "H",
        "division": "Huevo",
        "cedis": cedis,
        "tipo_venta": "VTA EN RUTA",
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
    # `cantidad_cajas` solo la trae facturado. En vendido y cobrado se queda en
    # None, no en 0: la interfaz debe poder distinguir "cero cajas" de "aquí no
    # aplica esta métrica".
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


def test_la_cantidad_no_se_suma_entre_unidades(cliente):
    # CS, PZA y KG no son comparables. Si esto se "arregla" sumándolas, el KPI
    # queda plausible y mal, que es la peor combinación.
    cliente(
        [
            _fila("facturado", date(2026, 7, 1), "Leon 1", 10.0, unidad="CS", cantidad=5.0),
            _fila("facturado", date(2026, 7, 2), "Leon 1", 10.0, unidad="PZA", cantidad=300.0),
            _fila("facturado", date(2026, 7, 3), "Leon 1", 10.0, unidad="CS", cantidad=2.0),
        ]
    )

    resultado = _flujo()

    assert resultado["cantidad_por_unidad"] == [
        {"fase": "facturado", "unidad": "CS", "cantidad_total": 7.0},
        {"fase": "facturado", "unidad": "PZA", "cantidad_total": 300.0},
    ]
    # Y no existe ningún total agregado de cantidad que las mezcle.
    assert "cantidad_total" not in resultado["resumen"][0]


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
