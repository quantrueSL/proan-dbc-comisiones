-- =============================================================================
-- Comisiones DBC — verificaciones pendientes antes de dar por cerrado
-- Datos/sql/v1_flujo_producto_dbc.sql
-- =============================================================================
-- Cada bloque corresponde a un TODO o supuesto concreto del script v1. Corre
-- cada uno, y con el resultado real se ajusta v1_flujo_producto_dbc.sql donde
-- haga falta. Ninguno de estos requiere que decidas nada de negocio todavía
-- (eso son las "dudas a futuro" de la sección 15.2 del borrador) — son solo
-- datos que hoy no puedo ver desde aquí.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- V1. Esquema real de las tablas fuente.
--     sap_VBAP/sap_VBAK: YA CONTESTADO (bquxjob_4806345d_19fcba6dbeb.json) --
--     ya aplicado en v1_flujo_producto_dbc.sql: ERDAT existe en ambas (se usa
--     la de VBAK), VKBUR y VTWEG SOLO existen en VBAK (no en VBAP -- era el
--     error reportado), VRKME es la unidad de venta real en VBAP, y no hay
--     company_code en ninguna de las dos (lo más parecido es BUKRS_VF en
--     VBAK, sin confirmar).
--     Falta correr esta parte solo para la tabla de facturado (para
--     verificar si trae número de línea -- línea 141 de
--     v1_flujo_producto_dbc.sql; el resto de sus campos ya se confirmaron
--     por la consulta de referencia del senior).
-- ─────────────────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type, ordinal_position
FROM `proan-quantrue.D30_INTEGRATION.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'sap_2lis_13_vditm_billing_document_item'
ORDER BY table_name, ordinal_position;

-- V1b. Lo mismo para sap_pago (¿tiene company_code o algo equivalente?).
--      Afecta: líneas 37-41.
SELECT table_name, column_name, data_type, ordinal_position
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'sap_pago'
ORDER BY ordinal_position;

-- V1c. Lo mismo para dm_business_area (nombre real de la columna
--      descriptiva de división). Afecta: línea 114 (y el mismo TODO en
--      apps/comisionesbi/comisionesbi/catalog_engine.py).
SELECT table_name, column_name, data_type, ordinal_position
FROM `proan-quantrue.D20_DIMENSION.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'dm_business_area'
ORDER BY ordinal_position;

-- ─────────────────────────────────────────────────────────────────────────
-- V2. YA CONTESTADO (script_job_03daef6792d496145c4a4f70c2f332fc_3.json).
--     187 combinaciones almacén+oficina con más de una fila; de esas, 151
--     son duplicados inofensivos (mismo sector repetido) y 36 SÍ son un
--     conflicto real, siempre entre "Huevo (H) y Croqueta (IA)" y
--     "Tortilla (A)". Documentado en el borrador, sección 9 pendiente #1 y
--     sección 15.2/15.3 -- ya no es un TODO técnico, es una decisión de
--     negocio pendiente (cómo repartir esos 36 casos).
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  almacen,
  oficina,
  COUNT(*) AS n_filas,
  COUNT(DISTINCT sector) AS n_sectores,
  ARRAY_AGG(DISTINCT sector) AS sectores
FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
GROUP BY almacen, oficina
HAVING COUNT(*) > 1
ORDER BY n_filas DESC;

-- ─────────────────────────────────────────────────────────────────────────
-- V3. YA CONTESTADO. La lista original (19 plantas) NO era exhaustiva --
--     faltaban H7DU y H7TX. Ya corregido en v1_flujo_producto_dbc.sql y en
--     la sección 2 del borrador (ahora 21 plantas).
-- ─────────────────────────────────────────────────────────────────────────
SELECT DISTINCT receiving_plant
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC'
ORDER BY receiving_plant;

-- ─────────────────────────────────────────────────────────────────────────
-- V4. YA CONTESTADO. Sí existen facturas repartidas entre 2 almacenes
--     (mismo centro, misma oficina). Documentado en el borrador, sección 9
--     pendiente #9 y sección 15.2 -- decisión de negocio pendiente (cómo
--     repartir el monto cobrado entre esos almacenes); `factura_sitio_v1`
--     sigue usando una regla provisional mientras tanto.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  billing_document,
  COUNT(DISTINCT receiving_plant) AS n_plantas,
  COUNT(DISTINCT storage_location) AS n_almacenes,
  COUNT(DISTINCT sales_office) AS n_oficinas
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01'
GROUP BY billing_document
HAVING n_plantas > 1 OR n_almacenes > 1 OR n_oficinas > 1
LIMIT 100;

-- ─────────────────────────────────────────────────────────────────────────
-- V5/V5b. YA CONTESTADO -- cifras finales (post fix de company_code Y de
--     document_category = 'M', V7/V8) en la sección 15.3 del borrador:
--     vendido/facturado sin cambios; cobrado terminó en 51,763 filas,
--     12,822 (24.8%) sin CEDIS resuelto, mismo monto total en las 3 corridas
--     ($1,758,736,858.44) -- confirma que nunca se perdió dinero real, solo
--     movimientos contables sin sitio/factura.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  fase,
  COUNT(*) AS n_filas,
  SUM(monto) AS monto_total,
  MIN(fecha) AS fecha_min,
  MAX(fecha) AS fecha_max
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
GROUP BY fase
ORDER BY fase;

-- V5b. ¿Cuántas filas quedaron sin CEDIS resuelto? (join contra
--      dim_cedis_v1 sin match -- esperado hasta ~7.5% según la cobertura de
--      dm_cedis documentada en la sección 3, pero conviene confirmarlo aquí
--      también para el periodo real que cubre v1).
SELECT fase, COUNT(*) AS filas_sin_cedis
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
WHERE cedis IS NULL
GROUP BY fase;

-- ─────────────────────────────────────────────────────────────────────────
-- V6. Por qué "cobrado" solo cruza ~50% con facturado (V5/V5b: 39,203 de
--     78,146 sin match), contra el 75% de cobertura ya documentado en la
--     sección 3 ("Momento de cobro"). OJO: ese 75% se midió probablemente
--     en la dirección facturado→pago (qué % de lo facturado ya tiene pago);
--     esto de aquí es pago→facturado (qué % de los pagos encuentra su
--     factura) -- no tienen por qué coincidir aunque sea la misma relación.
--     V6a/V6b buscan un problema de formato (padding); V6c confirma si el
--     monto de las filas sin match es de verdad cero (antes de asumirlo).
-- ─────────────────────────────────────────────────────────────────────────

-- V6a. Muestra de pagos DBC 2026 que no cruzan con ninguna factura.
SELECT g.billing_document, LENGTH(g.billing_document) AS largo, g.clearing_date, g.paid_amount_mxn
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago` g
LEFT JOIN (
  SELECT DISTINCT billing_document
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
) f ON f.billing_document = g.billing_document
WHERE g.company_code = 'DBC'
  AND g.clearing_date >= '2026-01-01'
  AND f.billing_document IS NULL
LIMIT 20;

-- V6b. Distribución de longitud de billing_document en ambas tablas -- si
--      los rangos no se parecen, es señal de padding/formato distinto.
SELECT 'sap_pago' AS origen, LENGTH(billing_document) AS largo, COUNT(*) AS n
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago`
WHERE company_code = 'DBC'
GROUP BY largo
UNION ALL
SELECT 'facturado' AS origen, LENGTH(billing_document) AS largo, COUNT(*) AS n
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC'
GROUP BY largo
ORDER BY origen, largo;

-- V6c. ¿El monto de las filas sin match es de verdad cero? (antes de
--      asumirlo solo porque el monto_total de V5 no se movió).
SELECT
  COUNT(*) AS total_filas,
  COUNTIF(f.billing_document IS NULL) AS filas_sin_match,
  SUM(g.paid_amount_mxn) AS monto_total,
  SUM(IF(f.billing_document IS NULL, g.paid_amount_mxn, 0)) AS monto_sin_match
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago` g
LEFT JOIN (
  SELECT DISTINCT billing_document
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
) f ON f.billing_document = g.billing_document
WHERE g.company_code = 'DBC' AND g.clearing_date >= '2026-01-01';

-- ─────────────────────────────────────────────────────────────────────────
-- V7. YA CONTESTADO (script_job_02225f6705e7e46ad418fb5c74fa4b5c_3.json).
--     document_category separa el patrón casi perfecto: 100% de las 26,311
--     filas sin factura tiene category NULL (98% document_type 'DZ' --
--     compensaciones/ajustes internos); 99.86% (51,763/51,835) de las filas
--     con factura tiene category = 'M'; las 72 filas restantes con category
--     NULL aportan $0. document_type NO sirve como filtro (hay 456 filas
--     'RV' sin factura). Fix aplicado en v1_flujo_producto_dbc.sql: la rama
--     "cobrado" ahora filtra `AND g.document_category = 'M'` en vez de
--     depender solo de billing_document IS NOT NULL. Ver V8 para confirmar
--     que las cifras no cambiaron de forma inesperada tras el fix.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  (f.billing_document IS NULL) AS sin_factura,
  g.document_type,
  g.document_category,
  g.key_group,
  COUNT(*) AS n_filas,
  SUM(g.paid_amount_mxn) AS monto_total
FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago` g
LEFT JOIN (
  SELECT DISTINCT billing_document
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
) f ON f.billing_document = g.billing_document
WHERE g.company_code = 'DBC' AND g.clearing_date >= '2026-01-01'
GROUP BY sin_factura, g.document_type, g.document_category, g.key_group
ORDER BY sin_factura DESC, n_filas DESC;

-- ─────────────────────────────────────────────────────────────────────────
-- V8. YA CONTESTADO. Confirmado: 51,763 filas, monto_total idéntico
--     ($1,758,736,858.44 -- ni un peso perdido vs. las corridas anteriores),
--     rango 2026-01-02 a 2026-07-31, 12,822 (24.8%) sin CEDIS resuelto
--     (bajó de 39,203/50.2% con el fix de V7). Cifras ya trasladadas a la
--     sección 15.3 del borrador. Con esto, v1_flujo_producto_dbc.sql queda
--     cerrado para las 3 fases resueltas.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  fase,
  COUNT(*) AS n_filas,
  SUM(monto) AS monto_total,
  MIN(fecha) AS fecha_min,
  MAX(fecha) AS fecha_max
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
WHERE fase = 'cobrado'
GROUP BY fase;

SELECT fase, COUNT(*) AS filas_sin_cedis
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
WHERE cedis IS NULL AND fase = 'cobrado'
GROUP BY fase;

-- =============================================================================
-- Pendiente #7 (sección 9) — conversión de unidades a caja (CJ)
-- =============================================================================
-- Dos caminos posibles, ninguno confirmado con datos todavía:
--   A) `denominator_conversion_sku` -- ya está en la propia tabla de
--      facturado (sección 8), no necesita join. Falta confirmar si es
--      literalmente "unidades de sales_unit por caja" y si existe un campo
--      "numerador" hermano (patrón SAP típico: UMREZ/UMREN).
--   B) `MEINS_base_unit`/`MEINH_alternative_unit` -- viven en el maestro de
--      materiales, join por material_number. Falta primero encontrar la
--      tabla vigente (hay varios snapshots con fecha en el nombre) y
--      confirmar que trae el FACTOR numérico de conversión, no solo el
--      código de unidad (MEINS/MEINH son los códigos, no el factor).
-- V12 además dimensiona qué tan grande es el problema real: si la mayoría
-- de las filas ya vienen en una unidad que de por sí es "caja" (candidato:
-- `CS` = Case), la conversión solo aplicaría a una porción menor.
-- =============================================================================

-- V9. ¿Cuáles son los candidatos reales de "maestro de materiales" hoy, y en
--     qué dataset viven? (pendiente #5 de la sección 9 -- no se pudo listar
--     el contenido de D40/D60/D62 antes; esta consulta a nivel proyecto
--     puede ayudar también con eso). Ordenado para ver el snapshot más
--     reciente primero.
SELECT table_catalog, table_schema AS dataset, table_name
FROM `proan-quantrue.region-us-west4.INFORMATION_SCHEMA.TABLES`
WHERE table_name LIKE '%MATERIAL%' OR table_name LIKE '%MAESTRO%'
ORDER BY table_name DESC;

-- V10. Columnas de facturado relacionadas con conversión/unidad -- ¿hay un
--      "numerador" hermano de denominator_conversion_sku? ¿Qué tipo de dato
--      es? (complementa el V1 ya corrido para esta tabla).
SELECT column_name, data_type, ordinal_position
FROM `proan-quantrue.D30_INTEGRATION.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'sap_2lis_13_vditm_billing_document_item'
  AND (
    UPPER(column_name) LIKE '%CONVER%' OR UPPER(column_name) LIKE '%UNIT%'
    OR UPPER(column_name) LIKE '%UNIDAD%' OR UPPER(column_name) LIKE '%FACTOR%'
    OR UPPER(column_name) LIKE '%NUMERATOR%' OR UPPER(column_name) LIKE '%DENOMINATOR%'
  )
ORDER BY ordinal_position;
-- YA CONTESTADO (script_job_41585a4f623bf5fc29e3dfe1defa9c41_0.json): 5
-- columnas -- weight_unit, stockkeeping_units (NUMERIC),
-- denominator_conversion_sku (NUMERIC), volumen_unit, sales_unit. No hay
-- "numerator" pareja. `stockkeeping_units` es un candidato nuevo (no estaba
-- en la sección 8 del borrador) -- ver V13b para probar si ya es la
-- cantidad en cajas.

-- V11. Columnas del maestro de materiales (AJUSTAR el nombre de tabla/dataset
--      real con el resultado de V9 antes de correr esta) -- buscando el
--      FACTOR numérico de conversión (patrón SAP: UMREZ/UMREN), no solo los
--      códigos de unidad MEINS/MEINH.
SELECT column_name, data_type, ordinal_position
FROM `proan-quantrue.<DATASET_DE_V9>.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = '<TABLA_DE_V9>'
ORDER BY ordinal_position;

-- V12. Distribución real de `sales_unit` en facturado (DBC, 2026) -- para
--      dimensionar cuánto del problema es real. Si `CS` (candidato a "caja")
--      concentra la mayoría de filas/monto, la conversión solo importa para
--      el resto.
SELECT
  sales_unit,
  COUNT(*) AS n_filas,
  SUM(invoiced_quantity) AS cantidad_total,
  SUM(amount_mxn) AS monto_total
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01'
GROUP BY sales_unit
ORDER BY monto_total DESC;
-- YA CONTESTADO. `CS` es solo 50.6% del monto facturado DBC 2026 -- el
-- problema es real, no marginal: PAQ 31.2%, KG 9.3%, PZA 5.5%, SAC 3.0%
-- necesitan conversión para poder aplicar la tarifa $/caja de forma
-- consistente.

-- V13. Muestra de filas con unidad distinta a CS, para revisar a ojo si
--      `denominator_conversion_sku` da un factor que luzca razonable
--      (ej. 1 caja = 12/24 piezas) -- sanity check manual antes de construir
--      la fórmula real.
SELECT material_number, sales_unit, invoiced_quantity, denominator_conversion_sku
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01' AND sales_unit != 'CS'
LIMIT 30;

-- V13b. Prueba directa de la pista nueva: ¿`stockkeeping_units` ya es la
--       cantidad en cajas? Si `factor_implicito` ronda un número entero
--       razonable (12, 24, etc.) para un mismo material_number+sales_unit,
--       es una fuerte señal de que sí. Incluye denominator_conversion_sku
--       al lado para comparar los dos candidatos a la vez.
SELECT
  material_number,
  sales_unit,
  invoiced_quantity,
  stockkeeping_units,
  denominator_conversion_sku,
  SAFE_DIVIDE(invoiced_quantity, stockkeeping_units) AS factor_implicito
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01' AND sales_unit != 'CS'
ORDER BY material_number
LIMIT 30;
-- YA CONTESTADO (parcial). `denominator_conversion_sku` descartado: en
-- PAQ/PZA es literalmente 1 en todas las filas sin importar material ni
-- cantidad; en KG no guarda relación consistente con invoiced_quantity
-- (razones 100/50/25/20/4/3.57 sin patrón) -- no es un factor de conversión
-- confiable. `stockkeeping_units` en cambio da un factor_implicito
-- consistente de ~18.00 en las 13 filas del material 000000000000012011
-- (KG) -- señal fuerte de que ya trae la cantidad convertida a "unidad de
-- manejo" (caja). Falta confirmar que esto se sostenga en muchos materiales
-- y en las otras unidades (PAQ/PZA/SAC) -- ver V14/V15.

-- V14. ¿El factor invoiced_quantity/stockkeeping_units es constante POR
--      material+unidad a través de MUCHAS filas, no solo en el ejemplo de
--      KG? Ordenado por stddev DESC -- si incluso los peores casos tienen
--      stddev bajo relativo al promedio, confirma la hipótesis en general.
SELECT
  material_number,
  sales_unit,
  COUNT(*) AS n_filas,
  AVG(SAFE_DIVIDE(invoiced_quantity, stockkeeping_units)) AS factor_promedio,
  STDDEV(SAFE_DIVIDE(invoiced_quantity, stockkeeping_units)) AS factor_stddev
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01'
  AND sales_unit != 'CS'
  AND stockkeeping_units IS NOT NULL AND stockkeeping_units != 0
GROUP BY material_number, sales_unit
HAVING n_filas >= 5
ORDER BY factor_stddev DESC
LIMIT 50;
-- YA CONTESTADO. Confirmado con datos: entre los 50 PEORES casos (mayor
-- stddev de todo el dataset), la inmensa mayoría tiene stddev ≈ 0 (factor
-- perfectamente constante), incluyendo materiales con miles de filas
-- (15,168 / 14,830 / 25,584 filas, factor exacto 1.0). Únicas excepciones
-- reales: unidad `COM` completa (213 filas, CV 52-53%, 0.20% del monto
-- facturado) y un puñado de materiales `CUT`/`KG` de muestra chica (CV
-- 4-27%) -- impacto marginal (<0.5% del monto total). Pendiente #7 (sección
-- 9) RESUELTO: `stockkeeping_units` = cantidad en caja, ya aplicado en
-- v1_flujo_producto_dbc.sql como `cantidad_cajas` (solo en "facturado").

-- V15. ¿`stockkeeping_units` está bien poblado, o tiene huecos relevantes?
--      Por unidad, cuántas filas tienen NULL o 0 -- si es una porción
--      grande en alguna unidad, la pista no alcanza sola para esa unidad.
SELECT
  sales_unit,
  COUNT(*) AS n_filas,
  COUNTIF(stockkeeping_units IS NULL) AS n_null,
  COUNTIF(stockkeeping_units = 0) AS n_cero
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
WHERE company_code = 'DBC' AND billing_date >= '2026-01-01'
GROUP BY sales_unit
ORDER BY n_filas DESC;
-- YA CONTESTADO. Cero NULL y cero 0 en las 11 unidades (incluida CS) --
-- `stockkeeping_units` está 100% poblado, sin huecos por unidad.
