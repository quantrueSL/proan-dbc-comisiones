-- =============================================================================
-- Comisiones DBC + cobro. Base: v1_comision_dbc_completo.sql, sin tocarlo.
-- Agrega se_cobro/monto_cobrado/cantidad_cobrada/comision_cobrada, mismo
-- prorrateo que v1_flujo_producto_dbc_prototipo_v2.sql (pagado / con_impuestos).
-- =============================================================================
CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` AS

WITH

sets AS (
  SELECT
    LTRIM(CAST(MATNR AS STRING), '0') AS matnr_clean,
    ANY_VALUE(SETNAME) AS SETNAME
  FROM `proan-quantrue.D00_SANDBOX.sap_setleaf_comisiones`
  GROUP BY matnr_clean
),

cedis AS (
  SELECT
    f.storage_location AS almacen,
    f.sales_office      AS oficina,
    COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
    CASE
      WHEN COALESCE(dc.tipo_venta, dco.tipo_venta) IN ('VTA EN RUTA','VTA EN PISO') THEN 'MENUDEO'
      WHEN COALESCE(dc.tipo_venta, dco.tipo_venta) IN ('MED MAYOREO','MAYOREO')     THEN 'MAYOREO'
      ELSE NULL
    END AS canal
  FROM (SELECT DISTINCT storage_location, sales_office
        FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
        WHERE company_code = 'DBC') f
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc
         ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
         ON dc.cedis IS NULL AND dal.almacen = f.storage_location
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
         ON dc.cedis IS NULL AND dal.cedis IS NULL AND dco.oficina = f.sales_office
),

tarifas_h AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(HSANJUAN_PISO)      AS FLOAT64) AS HSANJUAN_MENUDEO,
    SAFE_CAST(TRIM(HSANJUAN_RUTA)      AS FLOAT64) AS HSANJUAN_RUTA,
    SAFE_CAST(TRIM(HSANJUAN_MMAY)      AS FLOAT64) AS HSANJUAN_MMAY,
    SAFE_CAST(TRIM(HSANJUAN_MAY)       AS FLOAT64) AS HSANJUAN_MAYOREO,
    SAFE_CAST(TRIM(HSANJUAN_ABASTOS)   AS FLOAT64) AS HSANJUAN_ABASTOS,
    SAFE_CAST(TRIM(HPORTALES_PISO)     AS FLOAT64) AS HPORTALES_MENUDEO,
    SAFE_CAST(TRIM(HPORTALES_RUTA)     AS FLOAT64) AS HPORTALES_RUTA,
    SAFE_CAST(TRIM(HPORTALES_MMAY)     AS FLOAT64) AS HPORTALES_MMAY,
    SAFE_CAST(TRIM(HPORTALES_MAY)      AS FLOAT64) AS HPORTALES_MAYOREO,
    SAFE_CAST(TRIM(HPORTALES_ABASTOS)  AS FLOAT64) AS HPORTALES_ABASTOS,
    SAFE_CAST(TRIM(HINDUSTRIA_PISO)    AS FLOAT64) AS HINDUSTRIA_MENUDEO,
    SAFE_CAST(TRIM(HINDUSTRIA_RUTA)    AS FLOAT64) AS HINDUSTRIA_RUTA,
    SAFE_CAST(TRIM(HINDUSTRIA_MMAY)    AS FLOAT64) AS HINDUSTRIA_MMAY,
    SAFE_CAST(TRIM(HINDUSTRIA_MAY)     AS FLOAT64) AS HINDUSTRIA_MAYOREO,
    SAFE_CAST(TRIM(HINDUSTRIA_ABASTOS) AS FLOAT64) AS HINDUSTRIA_ABASTOS,
    SAFE_CAST(TRIM(HRANCHERO_PISO)     AS FLOAT64) AS HRANCHERO_MENUDEO,
    SAFE_CAST(TRIM(HRANCHERO_RUTA)     AS FLOAT64) AS HRANCHERO_RUTA,
    SAFE_CAST(TRIM(HRANCHERO_MMAY)     AS FLOAT64) AS HRANCHERO_MMAY,
    SAFE_CAST(TRIM(HRANCHERO_MAY)      AS FLOAT64) AS HRANCHERO_MAYOREO,
    SAFE_CAST(TRIM(HRANCHERO_ABASTOS)  AS FLOAT64) AS HRANCHERO_ABASTOS
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_H_20260829`
),

tarifas_bo AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(CHOCOLATE_MENUDEO)  AS FLOAT64) AS CHOCOLATE_MENUDEO,
    SAFE_CAST(TRIM(CHOCOLATE_MAYOREO)  AS FLOAT64) AS CHOCOLATE_MAYOREO,
    SAFE_CAST(TRIM(VAINILLA_MENUDEO)   AS FLOAT64) AS VAINILLA_MENUDEO,
    SAFE_CAST(TRIM(VAINILLA_MAYOREO)   AS FLOAT64) AS VAINILLA_MAYOREO,
    SAFE_CAST(TRIM(CAJETA_MENUDEO)     AS FLOAT64) AS CAJETA_MENUDEO,
    SAFE_CAST(TRIM(CAJETA_MAYOREO)     AS FLOAT64) AS CAJETA_MAYOREO,
    SAFE_CAST(TRIM(SWICH_MENUDEO)      AS FLOAT64) AS SWICH_MENUDEO,
    SAFE_CAST(TRIM(SWICH_MAYOREO)      AS FLOAT64) AS SWICH_MAYOREO,
    SAFE_CAST(TRIM(SW_ROLL_MENUDEO)    AS FLOAT64) AS SW_ROLL_MENUDEO,
    SAFE_CAST(TRIM(SW_ROLL_MAYOREO)    AS FLOAT64) AS SW_ROLL_MAYOREO,
    SAFE_CAST(TRIM(BIG_CHO_MENUDEO)    AS FLOAT64) AS BIG_CHO_MENUDEO,
    SAFE_CAST(TRIM(BIG_CHO_MAYOREO)    AS FLOAT64) AS BIG_CHO_MAYOREO,
    SAFE_CAST(TRIM(BIG_VAI_MENUDEO)    AS FLOAT64) AS BIG_VAI_MENUDEO,
    SAFE_CAST(TRIM(BIG_VAI_MAYOREO)    AS FLOAT64) AS BIG_VAI_MAYOREO,
    SAFE_CAST(TRIM(VUALA_BOLD_MENUDEO) AS FLOAT64) AS VUALA_BOLD_MENUDEO,
    SAFE_CAST(TRIM(VUALA_BOLD_MAYOREO) AS FLOAT64) AS VUALA_BOLD_MAYOREO,
    SAFE_CAST(TRIM(PINA_MENUDEO)       AS FLOAT64) AS PINA_MENUDEO,
    SAFE_CAST(TRIM(PINA_MAYOREO)       AS FLOAT64) AS PINA_MAYOREO,
    SAFE_CAST(TRIM(PMUERTO_MENUDEO)    AS FLOAT64) AS PMUERTO_MENUDEO,
    SAFE_CAST(TRIM(PMUERTO_MAYOREO)    AS FLOAT64) AS PMUERTO_MAYOREO
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_BO_20260829`
),

tarifas_ia AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(CHOP_MENUDEO)  AS FLOAT64) AS CHOP_MENUDEO,
    SAFE_CAST(TRIM(CHOP_MAYOREO)  AS FLOAT64) AS CHOP_MAYOREO,
    SAFE_CAST(TRIM(BALU_MENUDEO)  AS FLOAT64) AS BALU_MENUDEO,
    SAFE_CAST(TRIM(BALU_MAYOREO)  AS FLOAT64) AS BALU_MAYOREO,
    SAFE_CAST(TRIM(WOOFI_MENUDEO) AS FLOAT64) AS WOOFI_MENUDEO,
    SAFE_CAST(TRIM(WOOFI_MAYOREO) AS FLOAT64) AS WOOFI_MAYOREO,
    SAFE_CAST(TRIM(BALTO_MENUDEO) AS FLOAT64) AS BALTO_MENUDEO,
    SAFE_CAST(TRIM(BALTO_MAYOREO) AS FLOAT64) AS BALTO_MAYOREO,
    SAFE_CAST(TRIM(MIXI_MENUDEO)  AS FLOAT64) AS MIXI_MENUDEO,
    SAFE_CAST(TRIM(MIXI_MAYOREO)  AS FLOAT64) AS MIXI_MAYOREO,
    SAFE_CAST(TRIM(BONGO_MENUDEO) AS FLOAT64) AS BONGO_MENUDEO,
    SAFE_CAST(TRIM(BONGO_MAYOREO) AS FLOAT64) AS BONGO_MAYOREO
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_IA_20260829`
),

tarifas_l AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(LENTERA) AS FLOAT64) AS LENTERA,
    SAFE_CAST(TRIM(LLIGHT)  AS FLOAT64) AS LLIGHT,
    SAFE_CAST(TRIM(LDESLAC) AS FLOAT64) AS LDESLAC
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_L_20260829`
),

tarifas_a AS (
  SELECT
    WERKS, LGORT, VKBUR,
    LTRIM(CAST(MATNR AS STRING), '0') AS matnr_clean,
    COALESCE(
      SAFE_CAST(TRIM(SJABARROTES_SALAMANCA)    AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEON)         AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SALVATIERRA)  AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELAYA)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_QUERETARO)    AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_QROMMAY)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SILAO)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_MORELIA)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_URUAPAN)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEONAB)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEONABMMAY)   AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEON2)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_GENARO)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_IRAP2)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SANMIGUELALL) AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELPISO)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELMAY)       AS FLOAT64)
    ) AS tarifa
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_A_20260829`
),

facturas AS (
  SELECT
    f.billing_document,
    f.item_number,
    f.billing_date,
    f.company_code                                AS bukrs,
    f.sales_division                              AS gsber,
    f.sales_office                                AS vkbur,
    f.storage_location                            AS lgort,
    f.receiving_plant                             AS werks,
    LTRIM(CAST(f.material_number AS STRING), '0') AS matnr_clean,
    CASE
      WHEN f.sales_division IN ('H','IA') THEN CAST(f.net_weight AS FLOAT64)
      ELSE CAST(f.billing_quantity AS FLOAT64)
    END AS cantidad,
    f.amount_mxn                                  AS importe_mxn,
    f.currency
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
  WHERE f.company_code   = 'DBC'
    AND f.sales_division IN ('H','BO','IA','A','L')
    AND f.document_category = 'M'
    AND f.billing_date BETWEEN '2026-01-01' AND CURRENT_DATE()
    AND f.sales_office  NOT IN ('0001', '0174', '0175', '0181')
    AND f.storage_location NOT IN ('BO28','H793','BO01','H723')
),

base AS (
  SELECT
    f.*,
    s.SETNAME,
    c.tipo_venta,
    c.canal,
    th.HSANJUAN_RUTA,    th.HSANJUAN_MENUDEO,   th.HSANJUAN_MAYOREO,   th.HSANJUAN_MMAY,   th.HSANJUAN_ABASTOS,
    th.HPORTALES_RUTA,   th.HPORTALES_MENUDEO,  th.HPORTALES_MAYOREO,  th.HPORTALES_MMAY,  th.HPORTALES_ABASTOS,
    th.HINDUSTRIA_RUTA,  th.HINDUSTRIA_MENUDEO, th.HINDUSTRIA_MAYOREO, th.HINDUSTRIA_MMAY, th.HINDUSTRIA_ABASTOS,
    th.HRANCHERO_RUTA,   th.HRANCHERO_MENUDEO,  th.HRANCHERO_MAYOREO,  th.HRANCHERO_MMAY,  th.HRANCHERO_ABASTOS,
    tbo.CHOCOLATE_MENUDEO,  tbo.CHOCOLATE_MAYOREO,
    tbo.VAINILLA_MENUDEO,   tbo.VAINILLA_MAYOREO,
    tbo.CAJETA_MENUDEO,     tbo.CAJETA_MAYOREO,
    tbo.SWICH_MENUDEO,      tbo.SWICH_MAYOREO,
    tbo.SW_ROLL_MENUDEO,    tbo.SW_ROLL_MAYOREO,
    tbo.BIG_CHO_MENUDEO,    tbo.BIG_CHO_MAYOREO,
    tbo.BIG_VAI_MENUDEO,    tbo.BIG_VAI_MAYOREO,
    tbo.VUALA_BOLD_MENUDEO, tbo.VUALA_BOLD_MAYOREO,
    tbo.PINA_MENUDEO,       tbo.PINA_MAYOREO,
    tbo.PMUERTO_MENUDEO,    tbo.PMUERTO_MAYOREO,
    tia.CHOP_MENUDEO,  tia.CHOP_MAYOREO,
    tia.BALU_MENUDEO,  tia.BALU_MAYOREO,
    tia.WOOFI_MENUDEO, tia.WOOFI_MAYOREO,
    tia.BALTO_MENUDEO, tia.BALTO_MAYOREO,
    tia.MIXI_MENUDEO,  tia.MIXI_MAYOREO,
    tia.BONGO_MENUDEO, tia.BONGO_MAYOREO,
    tl.LENTERA,        tl.LLIGHT,         tl.LDESLAC,
    ta.tarifa          AS tarifa_a
  FROM facturas f
  LEFT JOIN sets s
    ON f.matnr_clean = s.matnr_clean
  LEFT JOIN cedis c
    ON f.lgort = c.almacen AND f.vkbur = c.oficina
  LEFT JOIN tarifas_h th
    ON f.gsber = 'H' AND f.werks = th.WERKS AND f.lgort = th.LGORT AND f.vkbur = th.VKBUR
  LEFT JOIN tarifas_bo tbo
    ON f.gsber = 'BO' AND f.werks = tbo.WERKS AND f.lgort = tbo.LGORT AND f.vkbur = tbo.VKBUR
  LEFT JOIN tarifas_ia tia
    ON f.gsber = 'IA' AND f.werks = tia.WERKS AND f.lgort = tia.LGORT AND f.vkbur = tia.VKBUR
  LEFT JOIN tarifas_l tl
    ON f.gsber = 'L' AND f.werks = tl.WERKS AND f.lgort = tl.LGORT AND f.vkbur = tl.VKBUR
  LEFT JOIN tarifas_a ta
    ON f.gsber = 'A' AND f.werks = ta.WERKS AND f.lgort = ta.LGORT AND f.vkbur = ta.VKBUR
   AND f.matnr_clean = ta.matnr_clean
),

con_tarifa AS (
  SELECT
    *,
    CASE
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   AND tipo_venta = 'VTA EN RUTA'               THEN HSANJUAN_RUTA
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   AND tipo_venta = 'VTA EN PISO'               THEN HSANJUAN_MENUDEO
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   AND tipo_venta IN ('MED MAYOREO','MAYOREO')  THEN HSANJUAN_MAYOREO
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   AND tipo_venta = 'ABASTOS'                   THEN HSANJUAN_ABASTOS
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  AND tipo_venta = 'VTA EN RUTA'               THEN HPORTALES_RUTA
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  AND tipo_venta = 'VTA EN PISO'               THEN HPORTALES_MENUDEO
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  AND tipo_venta IN ('MED MAYOREO','MAYOREO')  THEN HPORTALES_MAYOREO
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  AND tipo_venta = 'ABASTOS'                   THEN HPORTALES_ABASTOS
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' AND tipo_venta = 'VTA EN RUTA'               THEN HINDUSTRIA_RUTA
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' AND tipo_venta = 'VTA EN PISO'               THEN HINDUSTRIA_MENUDEO
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' AND tipo_venta IN ('MED MAYOREO','MAYOREO')  THEN HINDUSTRIA_MAYOREO
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' AND tipo_venta = 'ABASTOS'                   THEN HINDUSTRIA_ABASTOS
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  AND tipo_venta = 'VTA EN RUTA'               THEN HRANCHERO_RUTA
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  AND tipo_venta = 'VTA EN PISO'               THEN HRANCHERO_MENUDEO
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  AND tipo_venta IN ('MED MAYOREO','MAYOREO')  THEN HRANCHERO_MAYOREO
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  AND tipo_venta = 'ABASTOS'                   THEN HRANCHERO_ABASTOS

      WHEN gsber = 'BO' AND SETNAME = 'CHOCOLATE'  AND canal = 'MENUDEO' THEN CHOCOLATE_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'CHOCOLATE'  AND canal = 'MAYOREO' THEN CHOCOLATE_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'VAINILLA'   AND canal = 'MENUDEO' THEN VAINILLA_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'VAINILLA'   AND canal = 'MAYOREO' THEN VAINILLA_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'CAJETA'     AND canal = 'MENUDEO' THEN CAJETA_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'CAJETA'     AND canal = 'MAYOREO' THEN CAJETA_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'SWICH'      AND canal = 'MENUDEO' THEN SWICH_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'SWICH'      AND canal = 'MAYOREO' THEN SWICH_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'SW_ROLL'    AND canal = 'MENUDEO' THEN SW_ROLL_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'SW_ROLL'    AND canal = 'MAYOREO' THEN SW_ROLL_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'BIG_CHO'    AND canal = 'MENUDEO' THEN BIG_CHO_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'BIG_CHO'    AND canal = 'MAYOREO' THEN BIG_CHO_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'BIG_VAI'    AND canal = 'MENUDEO' THEN BIG_VAI_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'BIG_VAI'    AND canal = 'MAYOREO' THEN BIG_VAI_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'VUALA_BOLD' AND canal = 'MENUDEO' THEN VUALA_BOLD_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'VUALA_BOLD' AND canal = 'MAYOREO' THEN VUALA_BOLD_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'PINA'       AND canal = 'MENUDEO' THEN PINA_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'PINA'       AND canal = 'MAYOREO' THEN PINA_MAYOREO
      WHEN gsber = 'BO' AND SETNAME = 'PMUERTO'    AND canal = 'MENUDEO' THEN PMUERTO_MENUDEO
      WHEN gsber = 'BO' AND SETNAME = 'PMUERTO'    AND canal = 'MAYOREO' THEN PMUERTO_MAYOREO

      WHEN gsber = 'IA' AND SETNAME = 'CHOP'  AND canal = 'MENUDEO' THEN CHOP_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'CHOP'  AND canal = 'MAYOREO' THEN CHOP_MAYOREO
      WHEN gsber = 'IA' AND SETNAME = 'BALU'  AND canal = 'MENUDEO' THEN BALU_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'BALU'  AND canal = 'MAYOREO' THEN BALU_MAYOREO
      WHEN gsber = 'IA' AND SETNAME = 'WOOFI' AND canal = 'MENUDEO' THEN WOOFI_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'WOOFI' AND canal = 'MAYOREO' THEN WOOFI_MAYOREO
      WHEN gsber = 'IA' AND SETNAME = 'BALTO' AND canal = 'MENUDEO' THEN BALTO_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'BALTO' AND canal = 'MAYOREO' THEN BALTO_MAYOREO
      WHEN gsber = 'IA' AND SETNAME = 'MIXI'  AND canal = 'MENUDEO' THEN MIXI_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'MIXI'  AND canal = 'MAYOREO' THEN MIXI_MAYOREO
      WHEN gsber = 'IA' AND SETNAME = 'BONGO' AND canal = 'MENUDEO' THEN BONGO_MENUDEO
      WHEN gsber = 'IA' AND SETNAME = 'BONGO' AND canal = 'MAYOREO' THEN BONGO_MAYOREO

      WHEN gsber = 'L' AND SETNAME = 'LENTERA' THEN LENTERA
      WHEN gsber = 'L' AND SETNAME = 'LLIGHT'  THEN LLIGHT
      WHEN gsber = 'L' AND SETNAME = 'LDESLAC' THEN LDESLAC

      WHEN gsber = 'A' THEN tarifa_a
    END AS tarifa
  FROM base
),

-- Cobro: mismas dos CTEs que v1_flujo_producto_dbc_prototipo_v2.sql. Denominador
-- del prorrateo (con_impuestos) y el pago por factura (document_category='M').
factura_totales AS (
  SELECT
    billing_document,
    SUM(CAST(amount_total_mxn AS FLOAT64)) AS con_impuestos
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  WHERE company_code = 'DBC' AND document_category = 'M'
  GROUP BY billing_document
),

pago_factura AS (
  SELECT
    billing_document,
    MIN(CAST(clearing_date AS DATE)) AS fecha_cobro,
    ANY_VALUE(CAST(paid_amount_mxn AS FLOAT64)) AS pagado
  FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago`
  WHERE company_code = 'DBC' AND document_category = 'M'
    AND CAST(clearing_date AS DATE) >= '2026-01-01'
  GROUP BY billing_document
)

SELECT
  t.billing_document,
  t.item_number,
  t.billing_date,
  t.bukrs,
  t.gsber           AS division,
  t.vkbur           AS oficina_ventas,
  t.lgort           AS almacen,
  t.werks           AS planta,
  t.matnr_clean     AS matnr,
  t.SETNAME         AS set_material,
  t.tipo_venta,
  t.canal,
  t.cantidad,
  t.importe_mxn,
  t.tarifa,
  ROUND(t.cantidad * t.tarifa, 2) AS comision_mxn,
  CASE
    WHEN t.tarifa     IS NOT NULL THEN 'OK'
    WHEN t.SETNAME    IS NULL     THEN 'SIN_SET'
    WHEN t.tipo_venta IS NULL     THEN 'SIN_CEDIS'
    ELSE 'SIN_TARIFA'
  END AS status,

  p.billing_document IS NOT NULL AS se_cobro,
  ROUND(t.importe_mxn * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2)                     AS monto_cobrado,
  ROUND(t.cantidad    * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2)                     AS cantidad_cobrada,
  ROUND(t.cantidad * t.tarifa * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2)             AS comision_cobrada,
  p.fecha_cobro
FROM con_tarifa t
LEFT JOIN factura_totales ft ON ft.billing_document = t.billing_document
LEFT JOIN pago_factura p     ON p.billing_document   = t.billing_document
ORDER BY t.billing_date DESC, t.billing_document, t.item_number;
