-- =============================================================================
-- Conciliación por comisionista — detalle por producto, grano DIARIO.
-- Fuente: `dbc_comisiones_calculadas_cobro`, enriquecida con unidad/cantidad
-- nativa, descripción de producto y comisionista (misma cadena que
-- `DBC_gold_comision_diaria_v2`, ver ese archivo para el porqué de cada CTE).
--
-- Es la base de la que sale `v1_conciliacion_producto_semanal.sql` (agrega
-- por periodo de pago) y de la pestaña de detalle diario del Excel -- un solo
-- lugar para la lógica de enriquecimiento, no dos copias que se puedan desalinear.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`
PARTITION BY fecha
CLUSTER BY division_code, comisionista
AS
WITH cedis_resuelto AS (
  SELECT
    t.billing_document, t.item_number,
    COALESCE(dc.cedis, dal.cedis, dco.cedis) AS cedis
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` t
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc
         ON dc.almacen = t.almacen AND dc.oficina = t.oficina_ventas
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
         ON dc.cedis IS NULL AND dal.almacen = t.almacen
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
         ON dc.cedis IS NULL AND dal.cedis IS NULL AND dco.oficina = t.oficina_ventas
),
-- Comisionista por oficina -- misma cadena que `DBC_gold_comision_diaria_v2`
-- (2026-09-02): el nombre más largo por oficina, verificado contra las demás
-- grafías antes de aceptarlo. Copiada tal cual, ver ese archivo para el detalle.
comisionista_nombres AS (
  SELECT DISTINCT oficina, NULLIF(TRIM(persona), '') AS persona
  FROM (
    SELECT oficina, persona FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_almacen_oficina`
    UNION ALL
    SELECT oficina, persona FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa`
  )
  WHERE NULLIF(TRIM(persona), '') IS NOT NULL
),
comisionista_tokens AS (
  SELECT oficina, persona,
    ARRAY(
      SELECT DISTINCT UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(tok, NFKD), r'[^a-z0-9]', ''))
      FROM UNNEST(SPLIT(persona, ' ')) AS tok
      WHERE REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(tok, NFKD), r'[^a-z0-9]', '') != ''
    ) AS tokens
  FROM comisionista_nombres
),
comisionista_candidato AS (
  SELECT oficina, persona AS candidato, tokens AS tokens_candidato
  FROM comisionista_tokens
  QUALIFY ROW_NUMBER() OVER (PARTITION BY oficina ORDER BY ARRAY_LENGTH(tokens) DESC, persona) = 1
),
comisionista_verificado AS (
  SELECT
    t.oficina,
    ANY_VALUE(c.candidato) AS candidato,
    LOGICAL_AND(
      (SELECT LOGICAL_OR(tok = ctok OR EDIT_DISTANCE(tok, ctok) <= 1)
       FROM UNNEST(c.tokens_candidato) ctok)
    ) AS es_la_misma_persona
  FROM comisionista_tokens t, UNNEST(t.tokens) AS tok
  JOIN comisionista_candidato c ON c.oficina = t.oficina
  GROUP BY t.oficina
),
comisionista_excepciones AS (
  SELECT oficina, 'FLORENTINO GONZALEZ GARCIA' AS persona
  FROM UNNEST(['0011', '0093', '0094', '0143']) AS oficina
),
comisionista AS (
  SELECT
    v.oficina,
    COALESCE(e.persona, IF(v.es_la_misma_persona, v.candidato, NULL)) AS persona
  FROM comisionista_verificado v
  LEFT JOIN comisionista_excepciones e ON e.oficina = v.oficina
),
-- Unidad y cantidad tal como se facturó (ej. "9 SAC"). `invoiced_quantity` es
-- NUMERIC en la fuente -> castear a FLOAT64.
venta_nativa AS (
  SELECT
    billing_document, item_number,
    sales_unit AS unidad_venta,
    CAST(invoiced_quantity AS FLOAT64) AS cantidad_venta
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
),
-- Descripción de producto en español. Verificado 2026-09-02: 0 duplicados por
-- material dentro de SPRAS='S', 100% de cobertura contra lo facturado 2026.
descripcion AS (
  SELECT LTRIM(MATNR, '0') AS matnr_clean, MAKTX AS descripcion
  FROM `proan-quantrue.D00_SANDBOX.proan_MAKT_Materials_20260831`
  WHERE SPRAS = 'S'
),
base AS (
  SELECT
    t.billing_date                                            AS fecha,
    t.division                                                AS division_code,
    ba.business_area_name                                     AS division,
    cr.cedis,
    t.oficina_ventas                                          AS oficina,
    c.persona                                                 AS comisionista,
    t.tipo_venta,
    t.matnr,
    d.descripcion,
    v.unidad_venta,
    v.cantidad_venta,
    CASE t.division WHEN 'H' THEN 'kg' WHEN 'IA' THEN 'kg' ELSE 'caja' END AS base_unidad,
    t.cantidad                                                AS cantidad_base,
    t.tarifa,
    CAST(t.importe_mxn AS FLOAT64)                            AS monto,
    t.comision_mxn                                            AS comision,
    t.status
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` t
  LEFT JOIN cedis_resuelto cr
         ON cr.billing_document = t.billing_document AND cr.item_number = t.item_number
  LEFT JOIN venta_nativa v
         ON v.billing_document = t.billing_document AND v.item_number = t.item_number
  LEFT JOIN descripcion d
         ON d.matnr_clean = t.matnr
  LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba
         ON ba.business_area_code = t.division
  LEFT JOIN comisionista c
         ON c.oficina = t.oficina_ventas
)
SELECT
  fecha, division_code, division, cedis, oficina, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, base_unidad,
  ANY_VALUE(tarifa)             AS tarifa,
  COUNT(*)                      AS num_lineas,
  SUM(cantidad_venta)           AS cantidad_venta_total,
  SUM(monto)                    AS monto_total,
  SUM(cantidad_base)            AS cantidad_base_total,
  SUM(comision)                 AS comision_total,
  COUNTIF(status != 'OK')       AS lineas_sin_comision
FROM base
GROUP BY fecha, division_code, division, cedis, oficina, comisionista, tipo_venta,
         matnr, descripcion, unidad_venta, base_unidad;
