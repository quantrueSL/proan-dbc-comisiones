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
"""

from __future__ import annotations

import os

_bq_client = None  # cacheado a nivel de modulo


def get_bq_client():
    """Devuelve un `bigquery.Client` reutilizado entre llamadas."""
    global _bq_client
    if _bq_client is not None:
        return _bq_client

    from google.cloud import bigquery  # type: ignore

    project_id = os.environ["BQ_PROJECT_ID"]
    location = os.getenv("BQ_LOCATION", "us-west4")
    creds_path = os.getenv("BQ_CREDENTIALS_PATH")

    if creds_path:
        from google.oauth2 import service_account  # type: ignore

        credentials = service_account.Credentials.from_service_account_file(
            creds_path,
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        _bq_client = bigquery.Client(project=project_id, credentials=credentials, location=location)
    else:
        _bq_client = bigquery.Client(project=project_id, location=location)
    return _bq_client
