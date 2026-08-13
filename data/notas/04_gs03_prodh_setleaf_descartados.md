# Sección 5 (SET de producto) — dos vías adicionales descartadas

## SETLEAF / SETHEADER / SETNODE / GS01-02-03 / ZSDFI — confirmado que no existen

La sección 5 del borrador ya había descartado `SETLEAF`/`SETHEADER`/`SETNODE`
por búsqueda vacía, pero esa búsqueda se hizo cuando `D40_EDW`/`D60_REPORTING`/
`D62_STREAMLIT` estaban bloqueados por permisos. Con acceso completo, se
repitió la búsqueda contra **todos** los datasets del proyecto a la vez
(`region-us-west4.INFORMATION_SCHEMA.TABLES`, solo nombres de tabla):
`SETLEAF`, `SETHEADER`, `SETNODE`, `GS01`, `GS02`, `GS03`, `ZSDFI` — **cero
resultados en todo el proyecto**. Confirmado: no es un tema de permisos, de
verdad no están replicadas en BigQuery. GS03 sigue siendo estrictamente
necesario del cliente.

## PRODH (jerarquía de producto) — existe, pero no resuelve el problema

La sección 5 dejaba pendiente revisar "si el maestro de materiales tiene
algún campo de jerarquía (tipo PRODH u otro) más confiable que el texto
libre". Se encontró:

- `PRODH` **sí existe**, pero solo en los snapshots diarios de `D00_SANDBOX`
  (`proan_2LIS_13_VDITM_YYYYMMDD`) — **no** en la tabla principal
  `D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`. Los snapshots
  sí se actualizan a diario (hay uno de hoy, 2026-08-10).
- Cruzando `PRODH` + `MAKTX` (vía `MATNR` contra `D00_SANDBOX.proan_MAKT_Materials_20260810`)
  para división H (Huevo): **`PRODH` no separa las marcas limpiamente**.
  El grupo `0000400001` mezcla en el mismo código materiales "SAN JUAN" y
  "PORTALES" — justo la distinción que se necesita para el SET. Parece
  agrupar por formato de empaque/presentación (ej. "30B CJ10"), no por marca
  comercial.

| PRODH | Materiales | Ejemplos de MAKTX |
|---|---|---|
| 0000400001 | 12 | HUEVO PORTALES 30B CJ10, HUEVO SAN JUAN 30B CJ10 (**mezclados**) |
| 0000400002 | 14 | HUEVO BCO CAJA PLASTICO 360, HUEVO BCO KRAFT 360 |
| 0000400004 | 6 | HUEVO BLANCO PORTALES (limpio, solo Portales) |
| 0000400007 | 2 | HUEVO BCO KRAFT 360, HUEVO INDUSTRIALIZACION 360 |
| 0000400005 | 1 | HUEVO BCO GRANEL 360 |
| 0000400009 | 1 | HUEVO BCO. RANCHERO |
| 0000400020 | 1 | HUEVO BLANCO AUTOSERVICIOS |

**Conclusión: `PRODH` queda descartado como sustituto de GS03**, igual que el
proxy por texto de la sección 5. No hay atajo dentro de BigQuery — GS03
sigue siendo el único bloqueante real para el SET de producto. (Muestra
limitada a un día de transacciones — 37 materiales de división H — pero el
caso de mezcla San Juan/Portales ya es suficiente para descartar la vía sin
necesitar más datos.)
