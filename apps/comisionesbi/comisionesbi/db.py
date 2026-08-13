"""Cliente de BigQuery compartido por los motores de comisionesbi.

Variables de entorno:
  BQ_PROJECT_ID        (obligatoria)
  BQ_LOCATION          (opcional — por defecto "us-west4")
  BQ_CREDENTIALS_PATH  (opcional — omitir para usar Application Default
                        Credentials, que es lo que se hace en Cloud Run)

Uso:
    from comisionesbi.db import get_bq_client
    client = get_bq_client()

Los valores SIEMPRE se pasan como parametros de consulta (`@nombre` +
`bigquery.ScalarQueryParameter`), nunca interpolados en la cadena SQL: eso seria
una via de inyeccion.

Errores: todo fallo de acceso a BigQuery se traduce a una excepcion de este
modulo (`BigQueryError` y sus dos hijas). Asi app.py puede responder un 503 con
el motivo en vez de un 500 generico, y el detalle completo queda en el log.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

_bq_client = None  # cacheado a nivel de modulo


class BigQueryError(RuntimeError):
    """Base de los fallos de BigQuery que la API traduce a 503."""


class BigQueryConfigError(BigQueryError):
    """No se puede construir el cliente: falta configuración o credenciales.

    Es un fallo de despliegue, no transitorio: reintentar no lo arregla.
    """


class BigQueryQueryError(BigQueryError):
    """La consulta falló (permisos, cuota, tabla movida, servicio caído...)."""


def get_bq_client():
    """Devuelve un `bigquery.Client` reutilizado entre llamadas.

    Lanza `BigQueryConfigError` en vez del `KeyError` pelado de antes: el motivo
    llega así al log y al cliente en forma de 503 con explicación.
    """
    global _bq_client
    if _bq_client is not None:
        return _bq_client

    from google.auth.exceptions import GoogleAuthError  # type: ignore
    from google.cloud import bigquery  # type: ignore

    project_id = os.getenv("BQ_PROJECT_ID", "").strip()
    if not project_id:
        raise BigQueryConfigError(
            "BQ_PROJECT_ID no está definida: el servicio no puede consultar BigQuery."
        )

    location = os.getenv("BQ_LOCATION", "us-west4")
    creds_path = os.getenv("BQ_CREDENTIALS_PATH")
    credentials = None  # None ⇒ el cliente cae a credenciales de aplicación (ADC)

    if creds_path:
        from google.oauth2 import service_account  # type: ignore

        try:
            credentials = service_account.Credentials.from_service_account_file(
                creds_path,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        except (OSError, ValueError) as exc:
            # Fichero inexistente o ilegible (OSError) y JSON que no es una
            # cuenta de servicio válida (ValueError). Se nombra la ruta, nunca
            # el contenido: ahí está la clave privada.
            raise BigQueryConfigError(
                f"No se pudieron cargar las credenciales de BQ_CREDENTIALS_PATH ({creds_path}): {exc}"
            ) from exc

    try:
        client = bigquery.Client(project=project_id, credentials=credentials, location=location)
    except GoogleAuthError as exc:
        # Sin BQ_CREDENTIALS_PATH se usan ADC: en Cloud Run la identidad del
        # servicio, en local GOOGLE_APPLICATION_CREDENTIALS. Si no hay ninguna,
        # el fallo ocurre aquí y no en la primera consulta.
        raise BigQueryConfigError(
            f"No hay credenciales de aplicación utilizables para BigQuery: {exc}"
        ) from exc

    log.info(
        "Cliente de BigQuery creado (proyecto=%s, location=%s, credenciales=%s)",
        project_id,
        location,
        "fichero" if creds_path else "ADC",
    )
    _bq_client = client
    return _bq_client
