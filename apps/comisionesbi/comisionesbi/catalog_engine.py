"""Catálogos de dimensión para Comisiones DBC.

Fuentes ya resueltas y validadas (ver Comisiones_DBC_Borrador_Tecnico.md,
sección 3):
  - división de producto  → D20_DIMENSION.dm_business_area   (100% cobertura)
  - CEDIS + tipo de venta → D20_DIMENSION.dm_cedis            (~92.5% cobertura)

No incluye todavía el catálogo de SET de producto (marca/línea): depende del
export de GS03, pendiente del cliente (sección 5 / pregunta 1 de la sección 10).
"""

from __future__ import annotations

import logging

from google.api_core.exceptions import GoogleAPIError  # type: ignore
from google.auth.exceptions import GoogleAuthError  # type: ignore

from comisionesbi.db import BigQueryQueryError, get_bq_client

log = logging.getLogger(__name__)

# Confirmado contra el esquema real: la llave de cruce de dm_business_area es
# business_area_code (NO sales_division -- ese es el nombre del campo en las
# tablas de origen tipo sap_2lis_13_vditm_billing_document_item, no en esta
# tabla de dimensión), y business_area_name es la descripción.
_DIVISIONES_SQL = """
SELECT business_area_code, business_area_name
FROM `proan-quantrue.D20_DIMENSION.dm_business_area`
"""

_CEDIS_SQL = """
SELECT DISTINCT cedis, sector, almacen, oficina, tipo_venta
FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
ORDER BY cedis, oficina
"""


def _run_query(sql: str, nombre: str) -> list[dict]:
    """Ejecuta una consulta de catálogo y traduce los fallos de BigQuery.

    La lectura de filas va DENTRO del try: `result()` devuelve un iterador que
    pagina de forma perezosa, así que un error de permisos sobre la tabla no
    salta al llamar, sino al recorrer las filas.

    Al llamante le llega un mensaje propio, no el de Google: el crudo puede
    incluir nombres de tabla, proyecto o de la cuenta de servicio. Ese va al log.
    """
    client = get_bq_client()
    try:
        rows = client.query(sql).result()
        return [dict(row.items()) for row in rows]
    except (GoogleAPIError, GoogleAuthError) as exc:
        log.exception("Fallo consultando el catálogo de %s en BigQuery", nombre)
        raise BigQueryQueryError(f"No se pudo consultar el catálogo de {nombre}.") from exc


def divisiones() -> list[dict]:
    return _run_query(_DIVISIONES_SQL, "divisiones")


def cedis() -> list[dict]:
    return _run_query(_CEDIS_SQL, "CEDIS")


def catalog() -> dict:
    """Catálogo combinado — llamado por GET /v1/comisionesbi/catalog."""
    return {
        "divisiones": divisiones(),
        "cedis": cedis(),
        # TODO: agregar "sets" (marca/línea de producto) cuando llegue el
        # export de GS03. Ver sección 5 del borrador técnico.
    }
