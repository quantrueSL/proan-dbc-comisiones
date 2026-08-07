"""Catálogos de dimensión para Comisiones DBC.

Fuentes ya resueltas y validadas (ver Comisiones_DBC_Borrador_Tecnico.md,
sección 3):
  - división de producto  → D20_DIMENSION.dm_business_area   (100% cobertura)
  - CEDIS + tipo de venta → D20_DIMENSION.dm_cedis            (~92.5% cobertura)

No incluye todavía el catálogo de SET de producto (marca/línea): depende del
export de GS03, pendiente del cliente (sección 5 / pregunta 1 de la sección 10).
"""

from __future__ import annotations

from comisionesbi.db import get_bq_client

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


def divisiones() -> list[dict]:
    client = get_bq_client()
    rows = client.query(_DIVISIONES_SQL).result()
    return [dict(row.items()) for row in rows]


def cedis() -> list[dict]:
    client = get_bq_client()
    rows = client.query(_CEDIS_SQL).result()
    return [dict(row.items()) for row in rows]


def catalog() -> dict:
    """Catálogo combinado — llamado por GET /v1/comisionesbi/catalog."""
    return {
        "divisiones": divisiones(),
        "cedis": cedis(),
        # TODO: agregar "sets" (marca/línea de producto) cuando llegue el
        # export de GS03. Ver sección 5 del borrador técnico.
    }
