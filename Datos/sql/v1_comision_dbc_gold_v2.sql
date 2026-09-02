-- =============================================================================
-- GOLD v2 · Comisión DBC — agregado diario. Fuente: dbc_comisiones_calculadas_cobro
-- (v1_comision_dbc_completo_cobro.sql). Tabla que lee comisiones_engine.py.
--
-- Pendiente: base_unidad='caja' en BO/L/A es supuesto sin confirmar (H/IA en
-- kg sí confirmado). tipo_venta_origen no se rastrea (tarifa directa por SET+canal).
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_comision_diaria_v2`
PARTITION BY fecha
CLUSTER BY division_code, cedis, comision_estado
AS
WITH cedis_resuelto AS (
  -- Mismos 3 escalones de dbc_comisiones_calculadas_cobro, solo para exponer
  -- el nombre del CEDIS (la fuente no lo trae).
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

-- Comisionista por oficina (una persona cubre varias divisiones). Fuentes:
-- DBC_dim_almacen_oficina + DBC_dim_comision_tarifa, todas las hojas.
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
-- Candidato = grafía con más palabras (la más probable de ser el nombre completo).
comisionista_candidato AS (
  SELECT oficina, persona AS candidato, tokens AS tokens_candidato
  FROM comisionista_tokens
  QUALIFY ROW_NUMBER() OVER (PARTITION BY oficina ORDER BY ARRAY_LENGTH(tokens) DESC, persona) = 1
),
-- Verifica que las demás grafías de la oficina sean la misma persona: cada
-- palabra debe coincidir (o estar a 1 caracter, ej. Espinoza/Espinosa) contra
-- alguna palabra del candidato. Si no, son dos personas distintas.
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
-- Excepción manual: "FLORENTINO GLEZ" y "FLORENTINO GONZALEZ GARCIA" son la
-- misma persona (verificado con dm_vendors + BSIK), pero "GLEZ" no es
-- deducible de "GONZALEZ" con la regla genérica de arriba.
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

base AS (
  SELECT
    t.billing_date                                          AS fecha,
    t.division                                               AS division_code,
    ba.business_area_name                                    AS division,
    cr.cedis,
    t.oficina_ventas                                         AS oficina,
    c.persona                                                AS comisionista,
    t.tipo_venta,
    t.set_material                                           AS `set`,
    CASE t.division WHEN 'H' THEN 'kg' WHEN 'IA' THEN 'kg' ELSE 'caja' END AS base_unidad,
    t.cantidad AS cantidad_base,
    CASE t.status
      WHEN 'OK'         THEN 'calculada'
      WHEN 'SIN_SET'    THEN 'material sin SET'
      WHEN 'SIN_CEDIS'  THEN 'sin CEDIS/tipo de venta'
      WHEN 'SIN_TARIFA' THEN 'sin tarifa para esa llave'
    END AS comision_estado,
    CAST(t.importe_mxn AS FLOAT64)                           AS monto,
    t.comision_mxn                                           AS comision,
    t.comision_cobrada,
    t.monto_cobrado,
    IF(t.importe_mxn = 0, TRUE, FALSE)                       AS sin_importe
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` t
  LEFT JOIN cedis_resuelto cr
         ON cr.billing_document = t.billing_document AND cr.item_number = t.item_number
  LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba
         ON ba.business_area_code = t.division
  LEFT JOIN comisionista c
         ON c.oficina = t.oficina_ventas
)
SELECT
  fecha, division_code, division, cedis, oficina, comisionista, tipo_venta, `set`,
  base_unidad, comision_estado,
  CAST(NULL AS STRING) AS tipo_venta_origen,
  COUNT(*)                    AS num_lineas,
  SUM(monto)                  AS monto_total,
  SUM(cantidad_base)          AS cantidad_base_total,
  SUM(comision)                AS comision_total,
  CAST(NULL AS FLOAT64)        AS comision_min_total,
  CAST(NULL AS FLOAT64)        AS comision_max_total,
  SUM(comision_cobrada)        AS comision_cobrada,
  SUM(monto_cobrado)           AS monto_cobrado,
  COUNTIF(sin_importe)         AS lineas_sin_importe
FROM base
GROUP BY fecha, division_code, division, cedis, oficina, comisionista, tipo_venta, `set`,
         base_unidad, comision_estado;
