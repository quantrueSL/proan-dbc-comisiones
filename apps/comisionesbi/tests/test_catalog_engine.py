import logging
from unittest.mock import MagicMock

import pytest
from google.api_core.exceptions import Forbidden, ServiceUnavailable

from comisionesbi import catalog_engine
from comisionesbi.db import BigQueryQueryError


def _fake_client(rows):
    client = MagicMock()
    client.query.return_value.result.return_value = rows
    return client


def _failing_client(exc):
    client = MagicMock()
    client.query.side_effect = exc
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


# ─── Fallos de BigQuery ──────────────────────────────────────────────────


def test_error_de_permisos_se_traduce_y_deja_traza(monkeypatch, caplog):
    # El fallo más probable en producción: la identidad del servicio sin
    # permiso de lectura sobre el dataset de dimensiones.
    crudo = Forbidden("Access Denied: Table proan-quantrue:D20_DIMENSION.dm_business_area")
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: _failing_client(crudo))

    with caplog.at_level(logging.ERROR):
        with pytest.raises(BigQueryQueryError, match="divisiones"):
            catalog_engine.divisiones()

    # Sin la traza del original no se puede diagnosticar nada desde el log.
    assert any(registro.exc_info for registro in caplog.records)
    assert "divisiones" in caplog.text


def test_el_mensaje_al_llamante_no_filtra_el_error_de_google(monkeypatch):
    crudo = Forbidden("Access Denied: Table proan-quantrue:D20_DIMENSION.dm_business_area")
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: _failing_client(crudo))

    with pytest.raises(BigQueryQueryError) as error:
        catalog_engine.divisiones()

    assert "Access Denied" not in str(error.value)
    assert "D20_DIMENSION" not in str(error.value)
    # Pero el original sigue encadenado, que es lo que alimenta el log.
    assert isinstance(error.value.__cause__, Forbidden)


def test_el_nombre_del_catalogo_llega_en_el_mensaje(monkeypatch):
    # Con dos consultas por petición, saber cuál de las dos falló es la mitad
    # del diagnóstico.
    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("backend error"))
    )

    with pytest.raises(BigQueryQueryError, match="CEDIS"):
        catalog_engine.cedis()


def test_fallo_al_paginar_las_filas_tambien_se_captura(monkeypatch):
    # `result()` devuelve un iterador perezoso: hay errores que no saltan al
    # lanzar la consulta, sino al recorrer las páginas.
    def _filas():
        yield {"cedis": "Leon 1"}
        raise ServiceUnavailable("error leyendo la siguiente página")

    client = MagicMock()
    client.query.return_value.result.return_value = _filas()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: client)

    with pytest.raises(BigQueryQueryError):
        catalog_engine.cedis()


def test_catalog_propaga_el_fallo_en_vez_de_devolver_medio_catalogo(monkeypatch):
    # Devolver `divisiones` con `cedis` vacío sería peor que fallar: la interfaz
    # mostraría filtros incompletos como si fueran correctos.
    monkeypatch.setattr(catalog_engine, "divisiones", lambda: [{"business_area_code": "H"}])
    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("caído"))
    )

    with pytest.raises(BigQueryQueryError):
        catalog_engine.catalog()
