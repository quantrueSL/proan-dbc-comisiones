"""Módulo de conciliación documental (SAT) — objetivo detallado, módulo 3.

Relaciona las facturas de cada comisionista (proveedor) con sus documentos de
pago, para cumplir los requisitos del SAT en materia de pago de comisiones.

Estado (ver Comisiones_DBC_Borrador_Tecnico.md, sección 7): es la parte menos
avanzada del proyecto. Se identificó la fuente candidata (`FBL1N` → tabla
`sap_bsik_open_items` en BigQuery) pero no se ha validado ni construido nada
todavía. Falta además la relación comisionista ↔ oficinas de venta (pregunta 3
de la sección 10) y el rango de número de proveedor que identifica a los
comisionistas (pregunta 4).
"""

from __future__ import annotations

from fastapi import HTTPException


def build_reconciliation(*, provider_id: str | None, start_period: str, end_period: str) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/reconciliation.

    Todavía no implementado — ver el docstring del módulo para el porqué.
    """
    del provider_id, start_period, end_period
    raise HTTPException(
        status_code=501,
        detail=(
            "El módulo de conciliación documental no está construido todavía. "
            "Ver Comisiones_DBC_Borrador_Tecnico.md, sección 7."
        ),
    )
