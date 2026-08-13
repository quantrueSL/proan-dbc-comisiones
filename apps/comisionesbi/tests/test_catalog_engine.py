from unittest.mock import MagicMock

from comisionesbi import catalog_engine


def _fake_client(rows):
    client = MagicMock()
    client.query.return_value.result.return_value = rows
    return client


def test_divisiones_devuelve_filas_del_cliente(monkeypatch):
    fake_rows = [{"business_area_code": "H", "business_area_name": "Huevo"}]
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: _fake_client(fake_rows))

    assert catalog_engine.divisiones() == fake_rows


def test_cedis_devuelve_filas_del_cliente(monkeypatch):
    fake_rows = [
        {
            "cedis": "Leon 1",
            "sector": "Huevo (H) y Croqueta (IA)",
            "almacen": "H702",
            "oficina": "0005",
            "tipo_venta": "VTA EN RUTA",
        }
    ]
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: _fake_client(fake_rows))

    assert catalog_engine.cedis() == fake_rows


def test_catalog_combina_divisiones_y_cedis(monkeypatch):
    monkeypatch.setattr(catalog_engine, "divisiones", lambda: [{"business_area_code": "H"}])
    monkeypatch.setattr(catalog_engine, "cedis", lambda: [{"cedis": "Leon 1"}])

    assert catalog_engine.catalog() == {
        "divisiones": [{"business_area_code": "H"}],
        "cedis": [{"cedis": "Leon 1"}],
    }
