import logging

from fastapi.testclient import TestClient

from comisionesbi import app as app_module
from comisionesbi.db import BigQueryConfigError, BigQueryQueryError

CATALOG_URL = "/v1/comisionesbi/catalog"

client = TestClient(app_module.app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_report_returns_501_bloqueado():
    response = client.post(
        "/v1/comisionesbi/report",
        json={"start_period": "2026-01-01", "end_period": "2026-01-31"},
    )
    assert response.status_code == 501


def test_reconciliation_returns_501_bloqueado():
    response = client.post(
        "/v1/comisionesbi/reconciliation",
        json={"start_period": "2026-01-01", "end_period": "2026-01-31"},
    )
    assert response.status_code == 501


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


def test_health_no_toca_bigquery(monkeypatch):
    # El health check debe seguir respondiendo 200 con BigQuery caído: si no,
    # Cloud Run reciclaría la instancia sin motivo.
    def _falla():
        raise BigQueryQueryError("caído")

    monkeypatch.setattr(app_module, "build_catalog", _falla)

    assert client.get("/health").status_code == 200
