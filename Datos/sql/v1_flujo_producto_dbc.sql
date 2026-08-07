-- =============================================================================
-- Comisiones DBC — v1: flujo de producto (vendido, facturado, cobrado)
-- =============================================================================
-- Proyecto BigQuery: proan-quantrue (región us-west4).
-- Basado en Datos/Comisiones_DBC_Borrador_Tecnico.md, secciones 2, 3, 4, 9 y 11.
--
-- QUÉ SÍ incluye v1 (las 3 capas ya resueltas y validadas — sección 4):
--   - Vendido    (sap_VBAK + sap_VBAP)
--   - Facturado  (sap_2lis_13_vditm_billing_document_item)
--   - Cobrado    (sap_pago, heredando CEDIS/oficina de la factura vía billing_document,
--                 porque sap_pago no trae esos campos — sección 4.1)
--
-- QUÉ NO incluye v1 (a propósito, para no mezclar cifras sin validar con las
-- que sí lo están):
--   - Traspasos (candidata: sap_mseg). Sección 4.0 / pendiente #8: falta
--     validar que reproduce los totales de MB51. Cuando se valide, se añade
--     como cuarta rama del UNION ALL de abajo (mismo patrón).
--   - SET de producto (marca/línea): sin el export de GS03 no existe el
--     mapeo material_number → SET (sección 5). v1 expone material_number
--     (MATNR), que ya es más granular que el SET — sirve para el dashboard
--     ("detalle a tipo de producto"), NO para calcular comisión.
--
-- Grano de `v1_flujo_producto_dbc`: un renglón por evento (línea de pedido /
-- línea de factura / pago), con columna `fase` para distinguir. Debajo se
-- añade `v1_flujo_producto_dbc_resumen_diario`, agregada por
-- fecha × división × CEDIS × tipo_venta × fase, lista para KPIs/gráficas.
--
-- Todo lo que este script CREA (dim_cedis_v1, v1_flujo_producto_dbc,
-- v1_flujo_producto_dbc_resumen_diario) vive en `ZZ_PRUEBAS` mientras dure
-- esta fase de pruebas -- es el dataset destinado a eso. Cuando se valide,
-- se migra "en limpio" al dataset que corresponda (los origen -- dm_cedis,
-- dm_business_area, sap_* -- se siguen leyendo de donde ya viven).
--
-- Filtro DBC: `company_code = 'DBC'` es el filtro maestro (sección 2),
-- confirmado como campo real en `sap_2lis_13_vditm_billing_document_item`
-- (facturado, por la consulta de referencia del senior) Y en `sap_pago`
-- (INFORMATION_SCHEMA, V1b de v1_verificaciones.sql) -- ambas ramas filtran
-- directo por su propio `company_code`. En sap_VBAK/VBAP NO existe ese campo
-- (lo más parecido es `BUKRS_VF` en VBAK, semántica sin confirmar, no se
-- usó), así que "vendido" sigue dependiendo de la lista de plantas de la
-- sección 2 -- lista ya corregida contra datos reales (V3): faltaban H7DU y
-- H7TX.
--
-- Confirmado por consulta de referencia del senior + INFORMATION_SCHEMA
-- (facturado, 64 columnas): `material_number`, `sales_unit` (unidad de
-- `invoiced_quantity`) e `item_number` (número de línea) son nombres reales
-- de columna.
--
-- Pendiente #7 (sección 9, conversión a caja/CJ) -- RESUELTO. `sales_unit`
-- viene en unidades mixtas (CS/PZA/PAQ/SAC/KG/...), pero `stockkeeping_units`
-- (también en facturado) ya trae la cantidad convertida a unidad de manejo
-- (caja), validado con datos reales (V13b/V14/V15 de v1_verificaciones.sql):
-- factor invoiced_quantity/stockkeeping_units constante por material a
-- través de miles de filas (ej. ~18.00 para material 000000000000012011 en
-- KG; factor 1.0 exacto para la mayoría de PAQ/SAC/PZA), sin NULLs ni ceros
-- en ninguna unidad. Única excepción de bajo impacto: unidad `COM` (213
-- filas, 0.20% del monto facturado) y un puñado de materiales `CUT`/`KG` de
-- muestra chica muestran el factor inconsistente -- se dejan como están
-- (no se descartan ni se corrigen), el impacto es marginal. `denominator_conversion_sku`
-- quedó descartado como candidato (V13/V13b): es 1 fijo en PAQ/PZA y sin
-- relación consistente en KG. `cantidad_cajas` (`stockkeeping_units`) solo
-- existe en facturado -- no se confirmó un campo equivalente en vendido
-- (`sap_VBAP`) ni aplica a cobrado (`sap_pago` no llega a nivel material).
--
-- Confirmado vía INFORMATION_SCHEMA de sap_VBAK/sap_VBAP (ya no son TODO):
-- `dm_business_area` usa `business_area_code`/`business_area_name`, no
-- `sales_division`. `VKBUR` (oficina) y `VTWEG` (canal) SOLO existen en la
-- cabecera VBAK, no en el ítem VBAP -- se corrigió el alias (`k.` en vez de
-- `p.`) en la rama "vendido". `VRKME` es la unidad de venta real en VBAP.
--
-- Dos incógnitas de negocio quedaron confirmadas como reales con datos (no
-- son bugs, son casos genuinos sin regla definida todavía -- ver sección
-- 15.2 del borrador): 36 combinaciones almacén+oficina de dm_cedis mapean a
-- dos sectores distintos ("Huevo (H) y Croqueta (IA)" vs. "Tortilla (A)"),
-- y sí existen facturas repartidas entre 2 almacenes. Ambas siguen resueltas
-- aquí con una regla de desempate PROVISIONAL (ver los comentarios de
-- `dim_cedis_v1` y `factura_sitio_v1` más abajo).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Dimensión CEDIS deduplicada.
--    Borrador técnico, sección 9, pendiente #1. Ya medido (V2 de
--    v1_verificaciones.sql): de 187 combinaciones almacén+oficina con más
--    de una fila en dm_cedis, 151 son duplicados inofensivos (mismo sector
--    repetido) y 36 SÍ son un conflicto real -- siempre entre los mismos dos
--    sectores: "Huevo (H) y Croqueta (IA)" vs. "Tortilla (A)". Parecen
--    almacenes/oficinas compartidos entre esas divisiones. Regla de
--    desempate aquí sigue siendo PROVISIONAL (primer sector en orden
--    alfabético -> hoy siempre cae en "Huevo (H) y Croqueta (IA)") —
--    ajustar en cuanto el negocio confirme cómo repartir esos 36 casos.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` AS
SELECT * EXCEPT (rn)
FROM (
  SELECT
    almacen,
    oficina,
    cedis,
    sector,
    tipo_venta,
    ROW_NUMBER() OVER (PARTITION BY almacen, oficina ORDER BY sector) AS rn
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
)
WHERE rn = 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) v1: flujo de producto DBC — vendido + facturado + cobrado, un renglón
--    por evento. `plantas_dbc` (21 plantas, sección 2) es el filtro para
--    "vendido" -- "facturado" y "cobrado" ya filtran directo por su propio
--    `company_code`, así que ahí la lista de plantas es redundante (no
--    estorba, pero el filtro real es `company_code = 'DBC'`).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc` AS
WITH plantas_dbc AS (
  -- Lista corregida contra V3 de v1_verificaciones.sql (DISTINCT receiving_plant
  -- WHERE company_code='DBC'): la original (sección 2 del borrador) no traía
  -- H7DU ni H7TX -- con la lista vieja, esas dos plantas quedaban excluidas de
  -- "vendido" (que depende de esta lista al no tener company_code propio).
  SELECT planta FROM UNNEST([
    'DBCF','DBC1','DBC3','H7LA','H7L1','H7L2','H7SL','H7SI','H7AG','H7SM',
    'H7QU','H7CE','H7SA','H7MI','H7MO','H7UR','H7ZA','H7IR','H7SJ','H7DU','H7TX'
  ]) AS planta
),

-- `sap_2lis_13_vditm_billing_document_item` es a nivel LÍNEA (lo dice el
-- nombre): puede haber varias líneas por `billing_document`, y en teoría con
-- distinto centro/almacén/oficina cada una. La rama "cobrado" solo necesita
-- heredar el sitio de la factura (sección 4.1: sap_pago no lo trae), no
-- multiplicar `paid_amount_mxn` por cada línea -- por eso NO se hace join
-- directo contra la tabla de líneas, sino contra esta versión deduplicada
-- (un renglón por factura). Confirmado con datos reales (V4 de
-- v1_verificaciones.sql): SÍ existen facturas repartidas entre 2 almacenes
-- (mismo centro, misma oficina) -- la regla de desempate (primer almacén en
-- orden alfabético) sigue siendo PROVISIONAL, pendiente de que el negocio
-- diga cómo repartir esos casos.
factura_sitio_v1 AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      billing_document,
      receiving_plant,
      storage_location,
      sales_office,
      ROW_NUMBER() OVER (PARTITION BY billing_document ORDER BY receiving_plant, storage_location, sales_office) AS rn
    FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  )
  WHERE rn = 1
)

-- Vendido ---------------------------------------------------------------
SELECT
  'vendido' AS fase,
  CAST(k.ERDAT AS DATE) AS fecha,           -- confirmado vía INFORMATION_SCHEMA: ERDAT existe en ambas (VBAK y VBAP); se toma de la cabecera (k) por ser la fecha de creación del pedido
  CAST(p.VBELN AS STRING) AS documento,
  CAST(p.POSNR AS STRING) AS linea,
  p.SPART AS division_code,                 -- confirmado: SPART existe en VBAP (a nivel línea), no hace falta tomarlo de la cabecera
  ba.business_area_name AS division,        -- confirmado: dm_business_area usa business_area_code (llave) / business_area_name (descripción), no sales_division
  k.VTWEG AS canal_code,                    -- confirmado: VTWEG SOLO existe en VBAK (cabecera), no en VBAP
  dc.cedis,
  dc.tipo_venta,
  k.VKBUR AS oficina,                       -- confirmado: VKBUR SOLO existe en VBAK (cabecera), no en VBAP — este era el error reportado
  p.WERKS AS planta,
  p.LGORT AS almacen,
  p.MATNR AS material_number,
  CAST(p.KWMENG AS FLOAT64) AS cantidad,
  p.VRKME AS unidad,                        -- confirmado: VRKME es la unidad de venta real en VBAP (ya no es TODO)
  CAST(NULL AS FLOAT64) AS cantidad_cajas,  -- sin campo equivalente a stockkeeping_units confirmado en VBAP -- pendiente #7 solo se resolvió para facturado
  CAST(p.NETWR AS FLOAT64) AS monto,        -- indicativo, NO confiable (sección 4.3) — no usar para comisión ni para cuadrar contra lo cobrado
  FALSE AS monto_confiable
FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP` p
JOIN `proan-quantrue.D30_INTEGRATION.sap_VBAK` k ON k.VBELN = p.VBELN
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = p.SPART
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = p.LGORT AND dc.oficina = k.VKBUR
WHERE p.WERKS IN (SELECT planta FROM plantas_dbc)
  AND (p.ABGRU IS NULL OR p.ABGRU = '')    -- excluye líneas rechazadas/anuladas (sección 4.1)
  AND CAST(k.ERDAT AS DATE) >= '2026-01-01'

UNION ALL

-- Facturado ---------------------------------------------------------------
SELECT
  'facturado' AS fase,
  CAST(f.billing_date AS DATE) AS fecha,
  CAST(f.billing_document AS STRING) AS documento,
  f.item_number AS linea,                    -- confirmado: item_number es el número de línea real (INFORMATION_SCHEMA)
  f.sales_division AS division_code,
  ba.business_area_name AS division,
  f.distribution_channel AS canal_code,
  dc.cedis,
  dc.tipo_venta,
  f.sales_office AS oficina,
  f.receiving_plant AS planta,
  f.storage_location AS almacen,
  f.material_number AS material_number,     -- confirmado: nombre real de columna (consulta de referencia del senior)
  CAST(f.invoiced_quantity AS FLOAT64) AS cantidad,
  f.sales_unit AS unidad,                   -- confirmado: unidad de invoiced_quantity (CS/PZA/PAQ/SAC/KG/... — sección 8)
  CAST(f.stockkeeping_units AS FLOAT64) AS cantidad_cajas,  -- resuelve pendiente #7: cantidad ya convertida a unidad de manejo/caja (validado V13b/V14/V15); excepción de bajo impacto en COM/CUT (ver encabezado)
  CAST(f.amount_mxn AS FLOAT64) AS monto,   -- único monto confiable para comisión (sección 4.3)
  TRUE AS monto_confiable
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = f.sales_division
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
WHERE f.receiving_plant IN (SELECT planta FROM plantas_dbc)
  AND f.company_code = 'DBC'                -- filtro maestro (sección 2), confirmado como campo real por la consulta de referencia del senior
  AND CAST(f.billing_date AS DATE) BETWEEN '2026-01-01' AND CURRENT_DATE()  -- excluye años inválidos (2201/2202 — sección 2, pendiente #4)

UNION ALL

-- Cobrado / compensado ------------------------------------------------------
-- sap_pago no trae CEDIS/oficina/planta propios (sección 4.1) -- se heredan
-- de la factura vía billing_document. Tampoco llega a nivel material.
-- Confirmado (INFORMATION_SCHEMA, V1b): sap_pago SÍ tiene su propio
-- `company_code`, así que el filtro DBC va directo aquí (antes dependía
-- solo del `receiving_plant` heredado de la factura, lo que además
-- descartaba de golpe cualquier pago cuya factura no hiciera match en
-- `factura_sitio_v1` -- ya no: ahora esos pagos entran igual, solo con
-- planta/almacén/oficina/CEDIS en NULL).
-- `document_category = 'M'` (V7 de v1_verificaciones.sql): filtro semántico
-- real para quedarnos solo con movimientos de factura/cobro genuinos.
-- `billing_document IS NULL` era el síntoma, no la causa -- las 26,311 filas
-- sin factura (de 78,146) tienen 100% `document_category` NULL (98% son
-- document_type 'DZ', compensaciones/ajustes internos) y aportan $0. Del lado
-- "con factura", 99.86% (51,763 de 51,835) sí tiene `category = 'M'`; las 72
-- filas restantes con category NULL también aportan $0 -- se excluyen sin
-- perder monto real. Resultado: mismas cifras que el filtro anterior, pero
-- basado en el campo correcto.
SELECT
  'cobrado' AS fase,
  CAST(g.clearing_date AS DATE) AS fecha,
  CAST(g.billing_document AS STRING) AS documento,
  CAST(NULL AS STRING) AS linea,
  g.business_area_code AS division_code,
  ba.business_area_name AS division,
  g.distribution_channel AS canal_code,
  dc.cedis,
  dc.tipo_venta,
  f.sales_office AS oficina,
  f.receiving_plant AS planta,
  f.storage_location AS almacen,
  CAST(NULL AS STRING) AS material_number,
  CAST(NULL AS FLOAT64) AS cantidad,
  CAST(NULL AS STRING) AS unidad,
  CAST(NULL AS FLOAT64) AS cantidad_cajas,  -- sap_pago no llega a nivel material (sección 4.1)
  CAST(g.paid_amount_mxn AS FLOAT64) AS monto,
  TRUE AS monto_confiable
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago` g
LEFT JOIN factura_sitio_v1 f ON f.billing_document = g.billing_document
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = g.business_area_code
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
WHERE g.company_code = 'DBC'                -- filtro maestro directo sobre sap_pago (confirmado, ya no depende del join a factura_sitio_v1)
  AND g.document_category = 'M'             -- filtro semántico real (V7): excluye compensaciones/ajustes sin factura, no solo el síntoma billing_document IS NULL
  AND CAST(g.clearing_date AS DATE) >= '2026-01-01';

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Resumen diario — listo para KPIs/gráficas del dashboard (evita que
--    cada consulta del frontend tenga que agregar el detalle de línea).
-- ─────────────────────────────────────────────────────────────────────────
-- `unidad` entra en el GROUP BY a propósito: `cantidad` viene en unidades
-- mixtas (CS/PZA/PAQ/SAC/KG/... — sección 8), así que sumarla sin separar por
-- unidad mezclaría cosas no comparables. `cantidad_cajas` (pendiente #7,
-- resuelto -- ver encabezado) ya SÍ es comparable/sumable entre unidades
-- (solo existe para "facturado" -- NULL en vendido/cobrado, sección 8), por
-- eso se agrega aparte con su propio SUM, fuera del GROUP BY de `unidad`.
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc_resumen_diario` AS
SELECT
  fase,
  fecha,
  division_code,
  division,
  cedis,
  tipo_venta,
  unidad,
  COUNT(*) AS num_lineas,
  SUM(cantidad) AS cantidad_total,
  SUM(cantidad_cajas) AS cantidad_cajas_total,
  SUM(monto) AS monto_total
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
GROUP BY fase, fecha, division_code, division, cedis, tipo_venta, unidad;
