"""Conciliación por cortes: capa de datos (BigQuery simulado) y endpoints."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from comisionesbi import app as app_module
from comisionesbi import conciliacion_cortes_service as svc

client = TestClient(app_module.app)

D0 = date(2026, 6, 27)  # sábado
LIFNR = "0000001450"
MONTOS = [0 if i % 7 == 1 else 1000 + 137 * i for i in range(35)]


def _doc(n, ini, fin, pagado, *, valida=True, division="H", sociedad="DBC", lifnr=LIFNR, fecha_pago=None):
    return {
        "sociedad": sociedad,
        "doc_id": f"{sociedad}|2026|{n:010d}",
        "comisionista_id": lifnr,
        "division_code": division,
        "desde_texto": D0 + timedelta(days=ini) if valida else None,
        "hasta_texto": D0 + timedelta(days=fin) if valida else None,
        "ventana_valida": valida,
        "pagado": pagado,
        "fecha_pago": fecha_pago or D0 + timedelta(days=fin + 7),
        "comisionista": "EDGARDO TRUJILLO DE LA TORRE",
    }


def _suma(a, b):
    return float(sum(MONTOS[a : b + 1]))


@pytest.fixture
def bq(monkeypatch):
    """Dos semanas de pagos, la primera desfasada un día respecto al texto, más un documento sin ventana."""
    docs = [
        _doc(1, 0, 6, _suma(0, 5)),
        _doc(2, 7, 13, _suma(6, 13)),
        _doc(3, 99, 99, 500.0, valida=False, fecha_pago=date(2026, 7, 8)),
    ]
    diario = [
        {"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "fecha": D0 + timedelta(days=i), "comision": m}
        for i, m in enumerate(MONTOS)
    ]
    llamadas = []

    def fake(sql, nombre, parametros=None):
        llamadas.append((nombre, parametros))
        if "pagos por documento" in nombre:
            # como el SQL: un pago sin ventana solo entra por la fecha en que se pagó
            return [
                d for d in docs
                if d["ventana_valida"] or parametros["ini"][1] <= d["fecha_pago"] <= parametros["fin_pago"][1]
            ]
        if "cobros diarios" in nombre:
            return diario
        if "detalle por producto" in nombre:
            return [
                {"cedis": "Norte", "oficina": "0023", "tipo_venta": "VTA EN RUTA", "matnr": "1", "descripcion": "A",
                 "unidad_venta": "caja", "unidad_tarifa": "kg", "tarifa": 1.5, "num_lineas": 2,
                 "cantidad_venta_total": 10.0, "monto_total": 100.0, "cantidad_base_total": 300.0,
                 "comision_total": 450.0, "lineas_sin_comision": 0},
                {"cedis": "Norte", "oficina": "0023", "tipo_venta": "VTA EN RUTA", "matnr": "2", "descripcion": "B",
                 "unidad_venta": "caja", "unidad_tarifa": "kg", "tarifa": 1.5, "num_lineas": 1,
                 "cantidad_venta_total": 20.0, "monto_total": 200.0, "cantidad_base_total": 600.0,
                 "comision_total": 900.0, "lineas_sin_comision": 0},
            ]
        raise AssertionError(nombre)

    monkeypatch.setattr(svc, "run_query", fake)
    monkeypatch.setattr(svc, "cobertura", lambda: {"desde": "2026-01-02", "hasta": "2026-10-06"})
    return llamadas


def test_rango_mes():
    assert svc.rango_mes("2026-02") == (date(2026, 2, 1), date(2026, 2, 28))
    assert svc.rango_mes("2026-12") == (date(2026, 12, 1), date(2026, 12, 31))
    with pytest.raises(ValueError):
        svc.rango_mes("2026-13")


def test_el_mes_trae_los_pagos_con_su_estado_y_la_sugerencia(bq):
    r = svc.build_mes(mes="2026-07")
    assert r["cobertura"] == {"desde": "2026-01-02", "hasta": "2026-10-06"}
    (fila,) = r["filas"]
    assert fila["fila_id"] == f"DBC|{LIFNR}|H"
    assert fila["comisionista"] == "EDGARDO TRUJILLO DE LA TORRE"
    por_estado = {p["pago_id"]: p for p in fila["pagos"]}
    con_ventana = [p for p in fila["pagos"] if p["ini"]]
    # el primer pago termina el 3 jul pero se pagó hasta el 2: sugerencia única
    assert con_ventana[0]["estado"] == "sug"
    assert con_ventana[0]["sugerencia"]["unica"] is True
    assert {c["borde"] for c in con_ventana[0]["sugerencia"]["cambios"]} == {"fin", "ini"}
    assert con_ventana[0]["ini"] == "2026-06-27" and con_ventana[0]["fin"] == "2026-07-03"
    sin = [p for p in fila["pagos"] if p["estado"] == "sinv"]
    assert len(sin) == 1 and sin[0]["ini"] is None and sin[0]["pagado"] == 500.0
    assert len(por_estado) == 3


def test_los_pagos_que_no_tocan_el_mes_no_se_devuelven(bq):
    r = svc.build_mes(mes="2026-09")
    assert r["filas"] == []


def test_el_rango_cargado_lleva_margen_a_cada_lado(bq):
    svc.build_mes(mes="2026-07")
    nombre, params = bq[0]
    assert params["ini_ext"][1] == date(2026, 7, 1) - timedelta(days=svc.MARGEN_DIAS)
    assert params["fin_ext"][1] == date(2026, 7, 31) + timedelta(days=svc.MARGEN_DIAS)


def test_el_panel_trae_los_pagos_de_la_fila_y_sus_cobros_diarios(bq):
    r = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert len(r["fila"]["pagos"]) == 3
    assert len(r["dias"]) == 35
    assert r["dias"][0] == ["2026-06-27", MONTOS[0]]
    assert r["fila"]["cortes"][0]["fecha"] == "2026-07-03"


def test_el_panel_de_una_fila_inexistente_no_falla(bq):
    r = svc.build_fila(mes="2026-07", sociedad="PAN", comisionista_id="0000009999", division_code="H")
    assert r == {"mes": "2026-07", "fila": None, "dias": []}


def test_el_detalle_devuelve_las_filas_y_el_total_de_comision(bq):
    r = svc.build_detalle(sociedad="DBC", comisionista_id=LIFNR, division_code="H", ini=date(2026, 7, 4), fin=date(2026, 7, 10))
    assert r["comision_total"] == 1350.0
    assert [f["matnr"] for f in r["filas"]] == ["2", "1"]  # mayor cantidad primero


def test_endpoint_mes(bq):
    r = client.post("/v1/comisionesbi/cortes/mes", json={"mes": "2026-07"})
    assert r.status_code == 200
    assert r.json()["filas"][0]["pagos"][0]["estado"] in ("sug", "ok", "sin")


def test_endpoint_mes_rechaza_un_mes_mal_escrito():
    assert client.post("/v1/comisionesbi/cortes/mes", json={"mes": "julio"}).status_code == 422
    assert client.post("/v1/comisionesbi/cortes/mes", json={"mes": "2026-13"}).status_code == 422


def test_endpoint_fila_y_detalle(bq):
    r = client.post(
        "/v1/comisionesbi/cortes/fila",
        json={"mes": "2026-07", "sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H"},
    )
    assert r.status_code == 200 and len(r.json()["dias"]) == 35
    r = client.post(
        "/v1/comisionesbi/cortes/detalle",
        json={"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "ini": "2026-07-04", "fin": "2026-07-10"},
    )
    assert r.status_code == 200 and r.json()["comision_total"] == 1350.0


def test_endpoint_detalle_rechaza_un_rango_al_reves():
    r = client.post(
        "/v1/comisionesbi/cortes/detalle",
        json={"sociedad": "DBC", "comisionista_id": LIFNR, "ini": "2026-07-10", "fin": "2026-07-04"},
    )
    assert r.status_code == 422
