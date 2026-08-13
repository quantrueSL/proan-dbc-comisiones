from fastapi.testclient import TestClient

from comisionesbi.app import app

client = TestClient(app)


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
