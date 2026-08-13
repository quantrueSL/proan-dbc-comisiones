"""Catálogos de dimensión para Comisiones DBC.

Fuentes ya resueltas y validadas (ver Comisiones_DBC_Borrador_Tecnico.md,
sección 3):
  - división de producto  → D20_DIMENSION.dm_business_area   (100% cobertura)
  - CEDIS + tipo de venta → D20_DIMENSION.dm_cedis            (~92.5% cobertura)

No incluye todavía el catálogo de SET de producto (marca/línea): depende del
export de GS03, pendiente del cliente (sección 5 / pregunta 1 de la sección 10).

El resultado se cachea en memoria (ver `catalog()`): son datos de dimensión que
cambian al abrir un CEDIS nuevo, o sea meses, y sin caché cada render de página
del frontend dispara 2 jobs de BigQuery.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import NamedTuple

from google.api_core.exceptions import GoogleAPIError  # type: ignore
from google.auth.exceptions import GoogleAuthError  # type: ignore

from comisionesbi.db import BigQueryError, BigQueryQueryError, get_bq_client

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


# ─── Caché en memoria del catálogo ───────────────────────────────────────
# TTL alto a propósito: son dimensiones. El coste de servir un CEDIS con una
# hora de retraso es que falte en un desplegable; el de no cachear son 2 jobs
# de BigQuery por cada render de página del frontend (pide con `no-store`).
#
# Vive en el proceso, así que con `min-instances: 0` muere en cada arranque en
# frío y cada instancia tiene la suya. No hay invalidación global posible sin
# desplegar: el TTL es todo el mecanismo.

_CACHE_TTL_POR_DEFECTO = 3600

_cache_lock = threading.Lock()


class _CacheEntry(NamedTuple):
    expires_at: float
    catalog: dict


_cache: _CacheEntry | None = None


def _now() -> float:
    """Reloj monotónico — inmune a saltos de hora, y fijable desde los tests."""
    return time.monotonic()


def _cache_ttl_seconds() -> int:
    """TTL de la caché. `0` (o negativo) la desactiva; valor ilegible → defecto."""
    try:
        ttl = int(os.getenv("CATALOG_CACHE_TTL_SECONDS", ""))
    except ValueError:
        return _CACHE_TTL_POR_DEFECTO
    return max(ttl, 0)


def _build_catalog() -> dict:
    return {
        "divisiones": divisiones(),
        "cedis": cedis(),
        # TODO: agregar "sets" (marca/línea de producto) cuando llegue el
        # export de GS03. Ver sección 5 del borrador técnico.
    }


def catalog() -> dict:
    """Catálogo combinado — llamado por GET /v1/comisionesbi/catalog.

    Cacheado con TTL. Detalles que no son accidentales:

    - El lock se sostiene durante la consulta, no solo alrededor de la caché.
      Los endpoints síncronos de FastAPI corren en un threadpool, así que N
      peticiones con la caché fría serían N×2 jobs en paralelo; así solo
      consulta el primero y el resto espera y encuentra la caché caliente.
    - Un fallo no se cachea: memorizarlo alargaría la avería más allá de su causa.
    - Si BigQuery falla y hay una copia caducada, se sirve esa. Son opciones de
      filtro casi estáticas y un 503 aquí tumba las tres páginas. (Ojo: esto NO
      vale para la lista de acceso del frontend, donde servir una copia vieja
      dejaría entrar a un usuario dado de baja.)

    El dict devuelto es el mismo objeto que guarda la caché, no una copia: el
    único llamante lo serializa a JSON y no lo muta.
    """
    global _cache

    ttl = _cache_ttl_seconds()
    if ttl == 0:
        # Desactivada de verdad: no se guarda nada, así que tampoco hay copia
        # caducada que servir si BigQuery falla.
        return _build_catalog()

    with _cache_lock:
        if _cache is not None and _cache.expires_at > _now():
            return _cache.catalog

        try:
            catalogo = _build_catalog()
        except BigQueryError:
            if _cache is None:
                raise
            log.warning(
                "Catálogo no recargable desde BigQuery: se sirve la copia caducada",
                exc_info=True,
            )
            return _cache.catalog

        _cache = _CacheEntry(expires_at=_now() + ttl, catalog=catalogo)
        return catalogo


def invalidate_catalog_cache() -> None:
    """Fuerza la relectura en la siguiente llamada. Para operativa y pruebas."""
    global _cache
    with _cache_lock:
        _cache = None
