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
-- (2026-09-08): sale de `DBC_dim_comisionista`, cruzando por la sociedad de la
-- factura (`t.bukrs`) -- ver ese archivo para el porqué.
-- Copiada tal cual de ese archivo, ver ahí el detalle y las mediciones,
-- incluido el nombre canónico por `dm_vendors` (2026-09-10, ver ese archivo).
comisionista_src AS (
  SELECT
    c.sociedad, c.division, c.oficina,
    LPAD(TRIM(c.persona_cod), 10, '0')      AS comisionista_id,
    COALESCE(v.razon_social, c.persona)     AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comisionista` c
  LEFT JOIN (
    SELECT id_proveedor, ANY_VALUE(razon_social) AS razon_social
    FROM `proan-quantrue.D20_DIMENSION.dm_vendors`
    GROUP BY id_proveedor
  ) v ON v.id_proveedor = LPAD(TRIM(c.persona_cod), 10, '0')
  WHERE NULLIF(TRIM(c.oficina), '') IS NOT NULL
),
-- `s.comisionista_id` va calificado en el HAVING a propósito: sin el
-- prefijo, BigQuery lo resuelve al alias de arriba (ANY_VALUE, un agregado) y
-- falla con "Aggregations of aggregations are not allowed".
comisionista_oficina AS (
  SELECT sociedad, oficina, ANY_VALUE(s.comisionista_id) AS comisionista_id, ANY_VALUE(s.persona) AS persona
  FROM comisionista_src s
  GROUP BY sociedad, oficina HAVING COUNT(DISTINCT s.comisionista_id) = 1
),
comisionista_oficina_division AS (
  SELECT c.sociedad, c.oficina, c.division,
         ANY_VALUE(c.comisionista_id) AS comisionista_id, ANY_VALUE(c.persona) AS persona
  FROM comisionista_src c
  WHERE NOT EXISTS (SELECT 1 FROM comisionista_oficina o
                    WHERE o.sociedad = c.sociedad AND o.oficina = c.oficina)
  GROUP BY c.sociedad, c.oficina, c.division HAVING COUNT(DISTINCT c.comisionista_id) = 1
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
  t.bukrs                                                   AS sociedad,
  t.division                                                AS division_code,
  ba.business_area_name                                     AS division,
  cr.cedis,
  t.oficina_ventas                                          AS oficina,
  COALESCE(co.comisionista_id, cod.comisionista_id)         AS comisionista_id,
  COALESCE(co.persona, cod.persona)                         AS comisionista,
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
LEFT JOIN comisionista_oficina co
       ON co.sociedad = t.bukrs AND co.oficina = t.oficina_ventas
LEFT JOIN comisionista_oficina_division cod
       ON cod.sociedad = t.bukrs AND cod.oficina = t.oficina_ventas
      AND cod.division = t.division;
