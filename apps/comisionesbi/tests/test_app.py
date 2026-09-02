import logging
from datetime import date

from fastapi.testclient import TestClient

from comisionesbi import app as app_module
from comisionesbi.db import BigQueryConfigError, BigQueryQueryError

CATALOG_URL = "/v1/comisionesbi/catalog"

client = TestClient(app_module.app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_report_ya_no_esta_bloqueado(monkeypatch):
    # Devolvía 501 mientras faltaban los SETs y las tarifas. Llegaron el 24 de
    # agosto de 2026, así que ahora calcula: el test cambia de "está bloqueado"
    # a "responde", que es lo que hay que sostener a partir de aquí.
    monkeypatch.setattr(app_module, "build_report", lambda **_: {"totales": {}, "bloqueado": []})

    response = client.post(
        "/v1/comisionesbi/report",
        json={"start_date": "2026-01-01", "end_date": "2026-01-31"},
    )

    assert response.status_code == 200


def test_report_rechaza_un_rango_al_reves():
    # El endpoint aceptaba cadenas sueltas cuando devolvía 501 y daba igual lo
    # que le mandaran. Ahora la tabla es diaria y el rango tiene que ser válido.
    response = client.post(
        "/v1/comisionesbi/report",
        json={"start_date": "2026-08-31", "end_date": "2026-01-01"},
    )

    assert response.status_code == 422


def test_report_rechaza_una_fecha_que_no_lo_es():
    response = client.post(
        "/v1/comisionesbi/report",
        json={"start_date": "enero", "end_date": "2026-01-31"},
    )

    assert response.status_code == 422


def test_reconciliation_ya_no_esta_bloqueado(monkeypatch):
    # Devolvía 501: no había fuente para bajar del pago agregado a factura.
    # Desde el 2026-09-02 arma la conciliación por comisionista/producto sin
    # necesitar esa fuente (ver conciliacion_engine.py).
    monkeypatch.setattr(app_module, "build_conciliacion", lambda **_: {"por_comisionista": [], "detalle": []})

    response = client.post(
        "/v1/comisionesbi/reconciliation",
        json={"start_date": "2026-08-01", "end_date": "2026-08-31"},
    )

    assert response.status_code == 200


def test_reconciliation_rechaza_un_rango_al_reves():
    response = client.post(
        "/v1/comisionesbi/reconciliation",
        json={"start_date": "2026-08-31", "end_date": "2026-01-01"},
    )
    assert response.status_code == 422


def test_reconciliation_diario_devuelve_el_resultado_del_motor(monkeypatch):
    monkeypatch.setattr(app_module, "detalle_diario", lambda **_: [{"fecha": "2026-04-25"}])

    response = client.post(
        "/v1/comisionesbi/reconciliation/diario",
        json={"start_date": "2026-04-25", "end_date": "2026-04-30", "comisionista": "FLORENTINO GONZALEZ GARCIA"},
    )

    assert response.status_code == 200
    assert response.json() == [{"fecha": "2026-04-25"}]


def test_reconciliation_diario_rechaza_un_rango_al_reves():
    response = client.post(
        "/v1/comisionesbi/reconciliation/diario",
        json={"start_date": "2026-08-31", "end_date": "2026-01-01"},
    )
    assert response.status_code == 422


# ─── GET /catalog frente a fallos de BigQuery ────────────────────────────


def test_catalog_devuelve_el_catalogo(monkeypatch):
    monkeypatch.setattr(app_module, "build_catalog", lambda: {"divisiones": [], "cedis": []})

    response = client.get(CATALOG_URL)

    assert response.status_code == 200
    assert response.json() == {"divisiones": [], "cedis": []}


def test_catalog_devuelve_503_si_falla_la_consulta(monkeypatch, caplog):
    def _falla():
        raise BigQueryQueryError("No se pudo consultar el catálogo de divisiones.")

    monkeypatch.setattr(app_module, "build_catalog", _falla)

    with caplog.at_level(logging.ERROR):
        response = client.get(CATALOG_URL)

    # 503 y no 500: dependencia no disponible, y con motivo en el cuerpo.
    assert response.status_code == 503
    assert response.json() == {"detail": "No se pudo consultar el catálogo de divisiones."}
    assert CATALOG_URL in caplog.text


def test_catalog_con_mala_configuracion_no_expone_el_motivo(monkeypatch, caplog):
    def _falla():
        raise BigQueryConfigError("BQ_PROJECT_ID no está definida: el servicio no puede consultar BigQuery.")

    monkeypatch.setattr(app_module, "build_catalog", _falla)

    with caplog.at_level(logging.CRITICAL):
        response = client.get(CATALOG_URL)

    assert response.status_code == 503
    assert "BQ_PROJECT_ID" not in response.text
    # El motivo exacto sí queda en el log, que es donde hace falta.
    assert "BQ_PROJECT_ID" in caplog.text
    assert caplog.records[-1].levelno == logging.CRITICAL


# ─── POST /flujo ─────────────────────────────────────────────────────────

FLUJO_URL = "/v1/comisionesbi/flujo"
RANGO = {"start_date": "2026-01-01", "end_date": "2026-08-31"}


def test_flujo_devuelve_el_resultado_del_motor(monkeypatch):
    monkeypatch.setattr(app_module, "build_flujo", lambda **_: {"resumen": [], "cobertura": {}})

    response = client.post(FLUJO_URL, json=RANGO)

    assert response.status_code == 200
    assert response.json() == {"resumen": [], "cobertura": {}}


def test_flujo_pasa_los_filtros_al_motor_como_fechas(monkeypatch):
    recibido = {}
    monkeypatch.setattr(app_module, "build_flujo", lambda **kwargs: recibido.update(kwargs) or {})

    client.post(FLUJO_URL, json={**RANGO, "division": "H", "cedis": "Leon 1"})

    assert recibido["division"] == "H"
    assert recibido["cedis"] == "Leon 1"
    # Fechas de verdad, no cadenas: la tabla gold es diaria.
    assert recibido["start_date"] == date(2026, 1, 1)
    assert recibido["end_date"] == date(2026, 8, 31)


def test_flujo_rechaza_una_fecha_que_no_lo_es():
    response = client.post(FLUJO_URL, json={"start_date": "ayer", "end_date": "2026-08-31"})
    assert response.status_code == 422


def test_flujo_rechaza_un_rango_al_reves():
    # Devolvería vacío sin explicación; mejor decir que el rango está mal.
    response = client.post(FLUJO_URL, json={"start_date": "2026-08-31", "end_date": "2026-01-01"})
    assert response.status_code == 422


def test_flujo_devuelve_503_si_falla_bigquery(monkeypatch):
    def _falla(**_):
        raise BigQueryQueryError("No se pudo consultar el flujo de producto.")

    monkeypatch.setattr(app_module, "build_flujo", _falla)

    response = client.post(FLUJO_URL, json=RANGO)

    assert response.status_code == 503
    assert response.json() == {"detail": "No se pudo consultar el flujo de producto."}


def test_health_no_toca_bigquery(monkeypatch):
    # El health check debe seguir respondiendo 200 con BigQuery caído: si no,
    # Cloud Run reciclaría la instancia sin motivo.
    def _falla():
        raise BigQueryQueryError("caído")

    monkeypatch.setattr(app_module, "build_catalog", _falla)

    assert client.get("/health").status_code == 200
