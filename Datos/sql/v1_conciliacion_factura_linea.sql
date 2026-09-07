-- =============================================================================
-- Conciliación por comisionista — grano LÍNEA DE FACTURA (el más fino).
-- Fuente: `dbc_comisiones_calculadas_cobro`, con la misma cadena de
-- enriquecimiento que `DBC_gold_comision_diaria_v2` (comisionista, CEDIS,
-- descripción) -- ver ese archivo para el porqué de cada CTE.
--
-- Es la base real de la que salen `v1_conciliacion_producto_diario.sql`
-- (agrega por día) y, encima de esa, `v1_conciliacion_producto_semanal.sql`
-- (agrega por periodo de pago). Un solo lugar para la lógica de
-- enriquecimiento, no tres copias que se puedan desalinear.
--
-- INCLUYE COBRO (se_cobro/monto_cobrado/comision_cobrada), a diferencia de
-- diario/semanal que no lo traen: es la hoja de máximo detalle del Excel, y
-- cuando se pueda calcular la comisión sobre lo cobrado en vez de lo
-- facturado, el cálculo sale de aquí -- por eso tiene que estar ya, aunque
-- diario/semanal sigan sin usarlo (decisión de Silvana, 2026-09-02: en pausa
-- perseguir cobro mientras se arma la presentación, pero esta hoja es la
-- excepción a propósito).
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_factura_linea`
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
-- Unidad y cantidad de manejo por material -- `stockkeeping_units` (no
-- `invoiced_quantity`/`sales_unit` crudos, que vienen mezclados CS/PAQ/PZA/
-- SAC/KG dentro de una misma división). Confirmado 2026-09-07 con la
-- distribución real por división (monto DBC 2026): H 99.97% CS -> caja;
-- IA ~100% SAC -> saco; BO 99.4% PAQ -> paquete; A y L 100% PZA -> pieza.
venta_nativa AS (
  SELECT
    billing_document, item_number,
    CAST(stockkeeping_units AS FLOAT64) AS cantidad_venta
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
),
-- Descripción de producto en español. Verificado 2026-09-02: 0 duplicados por
-- material dentro de SPRAS='S', 100% de cobertura contra lo facturado 2026.
descripcion AS (
  SELECT LTRIM(MATNR, '0') AS matnr_clean, MAKTX AS descripcion
  FROM `proan-quantrue.D00_SANDBOX.proan_MAKT_Materials_20260831`
  WHERE SPRAS = 'S'
)
SELECT
  t.billing_document,
  t.item_number,
  t.billing_date                                            AS fecha,
  t.division                                                AS division_code,
  ba.business_area_name                                     AS division,
  cr.cedis,
  t.oficina_ventas                                          AS oficina,
  c.persona                                                 AS comisionista,
  t.tipo_venta,
  t.matnr,
  d.descripcion,
  CASE t.division
    WHEN 'H'  THEN 'caja'
    WHEN 'IA' THEN 'saco'
    WHEN 'BO' THEN 'paquete'
    WHEN 'A'  THEN 'pieza'
    WHEN 'L'  THEN 'pieza'
  END                                                        AS unidad_venta,
  v.cantidad_venta,
  CASE t.division
    WHEN 'H'  THEN 'kg'
    WHEN 'IA' THEN 'kg'
    WHEN 'A'  THEN 'pieza'
    WHEN 'L'  THEN 'pieza'
    WHEN 'BO' THEN 'paquete'
  END                                                        AS unidad_tarifa,
  t.cantidad                                                AS cantidad_base,
  t.tarifa,
  CAST(t.importe_mxn AS FLOAT64)                            AS monto,
  t.comision_mxn                                            AS comision,
  CASE t.status
    WHEN 'OK'         THEN 'calculada'
    WHEN 'SIN_SET'    THEN 'material sin SET'
    WHEN 'SIN_CEDIS'  THEN 'sin CEDIS/tipo de venta'
    WHEN 'SIN_TARIFA' THEN 'sin tarifa para esa llave'
  END AS comision_estado,
  t.se_cobro,
  t.monto_cobrado,
  t.cantidad_cobrada,
  t.comision_cobrada,
  t.fecha_cobro
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
       ON c.oficina = t.oficina_ventas;
