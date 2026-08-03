"""Módulo de comisión y compensación (objetivo detallado, componente central).

Bloqueado hasta tener:
  1. El export de GS03 (definición de SETs de producto por división) —
     sin esto no se puede agrupar `material_number` por marca/línea, que es
     la granularidad real de la tarifa de comisión.
  2. La tabla oficial de tarifas de comisión (TX ZSDFI_001) — hoy solo hay
     tarifas de referencia derivadas empíricamente de un reporte semanal del
     cliente (ver Comisiones_DBC_Borrador_Tecnico.md, sección 6.1), no una
     fuente sistemática y completa.

El modelo de 4 capas (traspasos → vendido → facturado → cobrado/compensado) y
la tabla de reglas de comisión (división × set × cedis × oficina × tipo_venta,
con vigencia) ya están diseñados — ver secciones 4 y 6.2 del borrador técnico.
Cuando lleguen los dos datos de arriba, este módulo pasa a construir esa vista
y aplicar la regla más específica que corresponda a cada transacción.
"""

from __future__ import annotations

from fastapi import HTTPException


def build_report(*, division: str | None, cedis: str | None, start_period: str, end_period: str) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/report.

    Todavía no implementado — ver el docstring del módulo para el porqué.
    """
    del division, cedis, start_period, end_period
    raise HTTPException(
        status_code=501,
        detail=(
            "El cálculo de comisión está bloqueado: falta el export de GS03 "
            "(SETs de producto) y la tabla oficial de tarifas (ZSDFI_001). "
            "Ver Comisiones_DBC_Borrador_Tecnico.md, secciones 5, 6.1 y 10."
        ),
    )
