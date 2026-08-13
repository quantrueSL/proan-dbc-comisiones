# Sección 7 (conciliación) — sap_bsik_open_items: estructura viable, falta aislar comisionistas

`sap_bsik_open_items` (`D30_INTEGRATION`) existe y tiene exactamente los
campos que se esperarían de `FBL1N` (partidas de proveedor): `LIFNR_vendor_number`,
`BUKRS_company_code`, `GSBER_business_area_code`, `DMBTR_amount_in_local_currency`,
`AUGDT_clearing_dt`/`AUGBL_document_number` (fecha/documento de compensación),
`ZTERM_payment_term`, `SAKNR_gl_account_number`. Estructuralmente es viable
para el módulo de conciliación. También existen `bsik_real_time`/
`bsak_real_time` (D00_SANDBOX) con ingesta continua (`_ingested_at`), sin
nombre de proveedor tampoco.

**No hay maestro de proveedores con nombre replicado en BigQuery** (se buscó
`LFA1`/`NAME1`/similar en todos los datasets, sin resultado) — no se puede
mapear número de proveedor → nombre de comisionista por cuenta propia.

**Tamaño del universo de proveedores por división** (`GSBER`, solo conteos,
sin datos de proveedor individuales):

| División | Proveedores distintos | LIFNR min | LIFNR max |
|---|---|---|---|
| A (Abarrote) | 7 | 0000001475 | 0000018131 |
| BO (Botana) | 112 | 0000000187 | BBV-670730 |
| H (Huevo) | 155 | 0000000139 | 0000023214 |
| IA (Alimento) | 70 | 0000000005 | 0000023209 |

Universo manejable (decenas, no miles) — buena señal para cuando el cliente
conteste la pregunta 4. Pero **mezcla proveedores normales (insumos,
empaque, etc.) con comisionistas** — no hay forma de aislar solo comisionistas
sin la respuesta del cliente (o sin encontrar un patrón de cuenta contable
(`SAKNR`/`HKONT`) o tipo de documento (`BLART`) específico para pagos de
comisión, que no se investigó a este nivel de detalle todavía).

Nota curiosa: al menos un `LIFNR` no sigue el formato numérico estándar
(`BBV-670730` en división BO) — el "rango de número de proveedor" de la
pregunta 4 quizá no sea un rango numérico limpio.

**Conclusión**: la fuente es viable técnicamente, pero la pregunta 4 de la
sección 10 (rango de proveedor + frecuencia de liquidación) sigue
dependiendo del cliente — esto no se resuelve solo con más SQL.
