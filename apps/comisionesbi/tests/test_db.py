"""Construcción del cliente de BigQuery y carga de credenciales.

No se toca la red: `bigquery.Client` se sustituye por una factoría falsa que
solo registra con qué argumentos se le llamó.
"""

import pytest
from google.auth.exceptions import DefaultCredentialsError
from google.cloud import bigquery
from google.oauth2 import service_account

from comisionesbi import db


@pytest.fixture(autouse=True)
def _entorno_limpio(monkeypatch):
    # El cliente se cachea en un global del módulo: sin resetearlo, el primer
    # test que lo construye deja a los demás sin ejecutar nada.
    monkeypatch.setattr(db, "_bq_client", None)
    for var in ("BQ_PROJECT_ID", "BQ_LOCATION", "BQ_CREDENTIALS_PATH"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def clientes_creados(monkeypatch):
    """Captura las llamadas a `bigquery.Client` y devuelve la lista de kwargs."""
    llamadas = []

    def _factory(**kwargs):
        llamadas.append(kwargs)
        return object()

    monkeypatch.setattr(bigquery, "Client", _factory)
    return llamadas


class _CredencialFalsa:
    pass


def test_sin_bq_project_id_da_error_de_configuracion(clientes_creados):
    with pytest.raises(db.BigQueryConfigError, match="BQ_PROJECT_ID"):
        db.get_bq_client()

    assert clientes_creados == []


def test_bq_project_id_en_blanco_cuenta_como_ausente(monkeypatch, clientes_creados):
    # El caso real: la variable declarada en service.yaml pero sin valor.
    monkeypatch.setenv("BQ_PROJECT_ID", "   ")

    with pytest.raises(db.BigQueryConfigError, match="BQ_PROJECT_ID"):
        db.get_bq_client()


def test_sin_credentials_path_usa_credenciales_de_aplicacion(monkeypatch, clientes_creados):
    # Es el modo de Cloud Run: la identidad del servicio, sin JSON en la imagen.
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")

    db.get_bq_client()

    assert clientes_creados == [
        {"project": "proan-quantrue", "credentials": None, "location": "us-west4"}
    ]


def test_bq_location_por_defecto_es_us_west4_y_es_configurable(monkeypatch, clientes_creados):
    # us-west4 es la región de BigQuery del proyecto; cambiarla sin querer
    # rompería las consultas con "dataset not found in location".
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")
    monkeypatch.setenv("BQ_LOCATION", "europe-west1")

    db.get_bq_client()

    assert clientes_creados[0]["location"] == "europe-west1"


def test_credentials_path_carga_el_fichero_y_lo_pasa_al_cliente(monkeypatch, clientes_creados):
    credencial = _CredencialFalsa()
    argumentos = {}

    def _from_file(path, scopes=None):
        argumentos["path"] = path
        argumentos["scopes"] = scopes
        return credencial

    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", _from_file)
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")
    monkeypatch.setenv("BQ_CREDENTIALS_PATH", "/ruta/cuenta.json")

    db.get_bq_client()

    assert argumentos == {
        "path": "/ruta/cuenta.json",
        "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
    }
    assert clientes_creados[0]["credentials"] is credencial


def test_credentials_path_inexistente_da_error_de_configuracion(monkeypatch, tmp_path, clientes_creados):
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")
    monkeypatch.setenv("BQ_CREDENTIALS_PATH", str(tmp_path / "no-existe.json"))

    with pytest.raises(db.BigQueryConfigError, match="no-existe.json"):
        db.get_bq_client()

    assert clientes_creados == []


def test_credentials_path_con_json_que_no_es_cuenta_de_servicio(monkeypatch, tmp_path, clientes_creados):
    fichero = tmp_path / "cuenta.json"
    fichero.write_text('{"algo": "que no es una cuenta de servicio"}', encoding="utf-8")
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")
    monkeypatch.setenv("BQ_CREDENTIALS_PATH", str(fichero))

    with pytest.raises(db.BigQueryConfigError):
        db.get_bq_client()


def test_el_error_de_credenciales_no_filtra_el_contenido_del_fichero(monkeypatch, tmp_path):
    # El JSON lleva la clave privada dentro: el mensaje nombra la ruta y nada más.
    fichero = tmp_path / "cuenta.json"
    fichero.write_text('{"private_key": "SECRETO-QUE-NO-DEBE-SALIR"}', encoding="utf-8")
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")
    monkeypatch.setenv("BQ_CREDENTIALS_PATH", str(fichero))

    with pytest.raises(db.BigQueryConfigError) as error:
        db.get_bq_client()

    assert "SECRETO-QUE-NO-DEBE-SALIR" not in str(error.value)


def test_sin_credenciales_de_aplicacion_da_error_de_configuracion(monkeypatch):
    # Correr en local sin `gcloud auth application-default login`.
    def _falla(**kwargs):
        raise DefaultCredentialsError("Could not automatically determine credentials")

    monkeypatch.setattr(bigquery, "Client", _falla)
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")

    with pytest.raises(db.BigQueryConfigError, match="credenciales de aplicación"):
        db.get_bq_client()


def test_el_cliente_se_construye_una_sola_vez(monkeypatch, clientes_creados):
    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")

    primero = db.get_bq_client()
    segundo = db.get_bq_client()

    assert primero is segundo
    assert len(clientes_creados) == 1


def test_un_fallo_no_deja_cacheado_un_cliente_roto(monkeypatch, clientes_creados):
    # Si el primer intento falla por configuración y luego se corrige, la
    # siguiente llamada debe volver a intentarlo.
    with pytest.raises(db.BigQueryConfigError):
        db.get_bq_client()

    monkeypatch.setenv("BQ_PROJECT_ID", "proan-quantrue")

    assert db.get_bq_client() is not None
    assert len(clientes_creados) == 1
