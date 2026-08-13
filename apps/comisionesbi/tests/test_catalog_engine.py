import logging
import threading
import time
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


@pytest.fixture(autouse=True)
def _cache_limpia():
    """`catalog()` cachea: sin esto un test dejaría el catálogo del anterior."""
    catalog_engine.invalidate_catalog_cache()
    yield
    catalog_engine.invalidate_catalog_cache()


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


# ─── Caché del catálogo ──────────────────────────────────────────────────


class _ClienteContador:
    """Cliente falso que cuenta las consultas lanzadas. Un catálogo = 2."""

    def __init__(self, demora: float = 0.0):
        self.consultas: list[str] = []
        self._demora = demora

    def query(self, sql):
        self.consultas.append(sql)
        time.sleep(self._demora)
        resultado = MagicMock()
        resultado.result.return_value = [{"fila": len(self.consultas)}]
        return resultado


@pytest.fixture
def reloj(monkeypatch):
    """Reloj monotónico fijo y avanzable, para no dormir en los tests del TTL."""
    actual = [1000.0]
    monkeypatch.setattr(catalog_engine, "_now", lambda: actual[0])
    return actual


def test_la_segunda_peticion_no_vuelve_a_consultar(monkeypatch, reloj):
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    primero = catalog_engine.catalog()
    segundo = catalog_engine.catalog()

    assert len(cliente.consultas) == 2  # divisiones + cedis, una sola vez
    assert segundo == primero


def test_al_vencer_el_ttl_vuelve_a_consultar(monkeypatch, reloj):
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    catalog_engine.catalog()
    reloj[0] += 3599
    catalog_engine.catalog()
    assert len(cliente.consultas) == 2

    reloj[0] += 2  # ya pasó la hora
    catalog_engine.catalog()
    assert len(cliente.consultas) == 4


def test_ttl_cero_desactiva_la_cache(monkeypatch, reloj):
    monkeypatch.setenv("CATALOG_CACHE_TTL_SECONDS", "0")
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    catalog_engine.catalog()
    catalog_engine.catalog()

    assert len(cliente.consultas) == 4


def test_con_ttl_cero_un_fallo_no_sirve_copia_caducada(monkeypatch, reloj):
    # Desactivada significa desactivada: no se guarda nada, así que no hay copia
    # vieja de la que tirar. Sin este test es fácil "arreglarlo" sin darse cuenta.
    monkeypatch.setenv("CATALOG_CACHE_TTL_SECONDS", "0")
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)
    catalog_engine.catalog()

    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("caído"))
    )

    with pytest.raises(BigQueryQueryError):
        catalog_engine.catalog()


def test_ttl_ilegible_cae_al_valor_por_defecto(monkeypatch):
    monkeypatch.setenv("CATALOG_CACHE_TTL_SECONDS", "una-hora")
    assert catalog_engine._cache_ttl_seconds() == 3600

    monkeypatch.delenv("CATALOG_CACHE_TTL_SECONDS")
    assert catalog_engine._cache_ttl_seconds() == 3600

    # Un negativo se trata como desactivada, no como caché eterna.
    monkeypatch.setenv("CATALOG_CACHE_TTL_SECONDS", "-5")
    assert catalog_engine._cache_ttl_seconds() == 0


def test_si_bigquery_falla_se_sirve_la_copia_caducada(monkeypatch, reloj, caplog):
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)
    bueno = catalog_engine.catalog()

    reloj[0] += 4000  # caducada
    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("caído"))
    )

    with caplog.at_level(logging.WARNING):
        assert catalog_engine.catalog() == bueno

    # Sirve la copia vieja, pero deja constancia: si no, la avería sería invisible.
    assert "copia caducada" in caplog.text
    assert any(registro.exc_info for registro in caplog.records)


def test_sin_copia_previa_el_fallo_se_propaga(monkeypatch, reloj):
    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("caído"))
    )

    with pytest.raises(BigQueryQueryError):
        catalog_engine.catalog()


def test_un_fallo_no_se_cachea(monkeypatch, reloj):
    monkeypatch.setattr(
        catalog_engine, "get_bq_client", lambda: _failing_client(ServiceUnavailable("caído"))
    )
    with pytest.raises(BigQueryQueryError):
        catalog_engine.catalog()

    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    assert catalog_engine.catalog()["divisiones"] == [{"fila": 1}]
    assert len(cliente.consultas) == 2


def test_invalidate_fuerza_la_relectura(monkeypatch, reloj):
    cliente = _ClienteContador()
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    catalog_engine.catalog()
    catalog_engine.invalidate_catalog_cache()
    catalog_engine.catalog()

    assert len(cliente.consultas) == 4


def test_peticiones_simultaneas_con_cache_fria_consultan_una_sola_vez(monkeypatch, reloj):
    # Los endpoints síncronos de FastAPI corren en un threadpool: sin el lock,
    # 10 peticiones concurrentes serían 20 jobs de BigQuery en paralelo.
    cliente = _ClienteContador(demora=0.02)
    monkeypatch.setattr(catalog_engine, "get_bq_client", lambda: cliente)

    resultados: list[dict] = []
    barrera = threading.Barrier(10)

    def _pedir():
        barrera.wait()
        resultados.append(catalog_engine.catalog())

    hilos = [threading.Thread(target=_pedir) for _ in range(10)]
    for hilo in hilos:
        hilo.start()
    for hilo in hilos:
        hilo.join()

    assert len(cliente.consultas) == 2
    assert len(resultados) == 10
    assert all(resultado == resultados[0] for resultado in resultados)
