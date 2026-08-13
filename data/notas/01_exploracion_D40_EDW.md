# Exploración D40_EDW — 2026-08-12

Contexto: `D40_EDW` (junto con `D60_REPORTING` y `D62_STREAMLIT`) estaba
marcado como "no se pudo listar, puede ser tema de permisos" en la sección 9
(pendiente #5) de `Datos/Comisiones_DBC_Borrador_Tecnico.md`. Con la cuenta
`quantrue1@proan.com` sí lista — pendiente resuelto, era permisos.

De los tres datasets, `D60_REPORTING` (Maka/Hidrocarburos, `MSJ_*` de
lealtad) y `D62_STREAMLIT` (`MSJ_*` lealtad/activación) no son relevantes
para Comisiones DBC. `D40_EDW` sí tiene tablas `edw_*` de facturación/pago
que sonaban a poder acelerar el proyecto — esta nota documenta qué se
encontró al revisarlas (solo esquema + agregados, sin datos a nivel
cliente/comisionista).

## Conteo total de filas por tabla (todas las compañías, sin filtro)

| Tabla | Filas | Estado |
|---|---|---|
| `edw_billing_header_payment` | 0 | **Muerta** — vacía |
| `edw_billing_items_payment` | 0 | **Muerta** — vacía |
| `edw_customer` | 22,902 | Viva |
| `edw_detail_billing_model` | 8,479,473 | Viva |
| `edw_header_billing_model` | 8,483,732 | Viva |
| `edw_header_billing_model_cedis` | 8,580,155 | Viva |
| `edw_status_billing_payment` | 8,483,732 | Viva, pero ver abajo |

Las dos tablas con sufijo `_payment` (`billing_header_payment`,
`billing_items_payment`) están completamente vacías — probablemente un
intento abandonado, no algo que dependa de permisos o filtro.

## `edw_status_billing_payment` — candidata a "cobrado": descartada

Prometía por nombre y columnas (`status_payment`, `balance`, `clearing_dt`),
pero **`status_payment` y `clearing_dt` están NULL en el 100% de las filas,
para las 22 compañías de la tabla** (verificado sin filtro de compañía:
8,483,732 filas totales, 0 con `status_payment` no nulo, 0 con `clearing_dt`
no nulo). Son columnas del esquema que nunca se llenaron — no es un problema
de permisos ni de filtro por `company_code = 'DBC'`.

**Conclusión: esta tabla no sirve para resolver "cobrado". La fuente
correcta sigue siendo `sap_pago`, como ya tiene el SQL v1.**

## `edw_header_billing_model_cedis` — candidata a "facturado": prometedora, pendiente de profundizar

Filtrando `company_code = 'DBC' AND billing_date >= '2026-01-01'`:

| | Esta tabla (EDW) | `v1_flujo_producto_dbc` (sección 15.3) |
|---|---|---|
| Filas | 193,536 | 1,745,163 |
| Monto (`amount`/`amount_mxm`) | $1,965,495,162.40 | $1,903,510,061.80 (+3.3%) |
| Monto (`amount_total_mxn`) | $2,024,192,741.22 (+6.3%) | — |
| Rango de fechas | 2026-01-01 a 2026-08-10 | 2026-01-01 a 2026-08-02 |

La diferencia de filas (~9x) es esperable: esta tabla es a nivel
**documento de facturación** (header), no a nivel línea como
`sap_2lis_13_vditm_billing_document_item` (que sí es la fuente de "facturado"
en el SQL v1). El monto está en el mismo orden de magnitud (+3.3% a +6.3%,
no exacto) — señal de que es información comparable, pero con reglas de
filtrado/agregación algo distintas todavía sin explicar.

Ya trae `sales_division`, `distribution_channel`, `plant_werks`,
`storage_location`, `sales_office`, `sales_group` — mismas dimensiones que
hoy se resuelven a mano vía `dm_cedis` con la regla de desempate provisional
(pendiente #1 de la sección 9). **Sin confirmar todavía si esta tabla
resuelve el fan-out de 36 combos almacén+oficina mejor que `dm_cedis`** —
sería el siguiente paso si se quiere profundizar en esta vía.

## Próximo paso sugerido (no ejecutado todavía)

Comparar, para los 36 combos almacén+oficina conflictivos ya identificados
en el SQL v1, qué división/sector asigna `edw_header_billing_model_cedis`
vs. la regla provisional actual — si coincide con una asignación no
arbitraria, podría resolver el pendiente #1 sin esperar al negocio.
