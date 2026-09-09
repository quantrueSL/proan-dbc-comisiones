-- =============================================================================
-- Comisiones DBC + cobro. Base: v1_comision_dbc_completo.sql, sin tocarlo.
-- Agrega se_cobro/monto_cobrado/cantidad_cobrada/comision_cobrada, mismo
-- prorrateo que v1_flujo_producto_dbc_prototipo_v2.sql (pagado / con_impuestos).
-- `comision_mxn` sigue siendo tarifa × facturado (comisión devengada, sin
-- tocar) -- `comision_cobrada` es tarifa × lo efectivamente cobrado.
--
-- 2026-09-07: fuente del cobro cambiada de sap_pago (~17% del facturado) a
-- sap_bsad_cleared_items (~87%, validado a nivel de monto).
--
-- 2026-09-08: SE INTEGRA LA SOCIEDAD PAN EN HUEVO. Antes solo entraba DBC, y
-- eso dejaba fuera la mayor parte de la comisión de huevo (PAN paga $66,2 M
-- contra $37,1 M de DBC en 2026 hasta el 8 de julio). El criterio del filtro
-- salió de la tabla de tarifa oficial de SAP -- ver el comentario de
-- `alcance_pan`, que es donde está documentada la decisión y su medición.
-- Efecto: la comisión devengada total pasa de $45,3 M a $107,6 M, y la
-- columna `bukrs` distingue una sociedad de la otra en toda la cadena.
--
-- 2026-09-08: BUG CORREGIDO en la tarifa de huevo -- MED MAYOREO y MAYOREO
-- son tarifas DISTINTAS en SAP (columnas separadas _MMAY / _MAY, "1/2
-- mayoreo" y "mayoreo" en el Excel del cliente), pero el CASE de más abajo
-- metía las dos en la misma rama apuntando siempre a _MAYOREO. MED MAYOREO
-- salía "sin tarifa" cada vez que _MAY estaba vacía, aunque _MMAY tuviera una
-- tarifa real -- confirmado en las 16 llaves bloqueadas de HSANJUAN/HPORTALES:
-- 100% con _MAY vacía y _MMAY con valor. $61,1 M que antes caían en "sin
-- tarifa para esa llave" ahora sí calculan.
--
-- 2026-09-08: REDISEÑO -- el tipo de venta (y con él la tarifa) ya no sale de
-- `dim_cedis_v1`/`dim_cedis_oficina_v1`, sale de la propia tabla de tarifa
-- (CTE `resuelto`, más abajo). Esto reemplaza y generaliza el fix anterior de
-- MED MAYOREO/MAYOREO -- ahora aplica a las 5 categorías de huevo y también a
-- botana/alimento, con el mismo principio: si dm_cedis apunta a una columna
-- con valor, se respeta; si no, se toma la única columna de esa tarifa que sí
-- tiene valor. Medido corriendo la query completa antes/después del cambio:
-- $110,4 M que antes caían en "sin tarifa para esa llave" ahora calculan --
-- $106,6 M en huevo (donde SIN_TARIFA queda en $0 -- el hueco que queda,
-- $5,5 M, es genuino: ninguna de las 5 columnas tiene valor, no un problema
-- de tipo de venta), $3,3 M en botana, $0,5 M en alimento. Leche y Abarrotes
-- no cambian (su tarifa no distingue tipo de venta/canal, nada que resolver).
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

-- 2026-09-08: BUG CORREGIDO -- `dim_cedis_almacen_v1` no tiene columna
-- `tipo_venta` (solo resuelve nombre de CEDIS, que esta CTE ni siquiera
-- expone), pero su éxito bloqueaba el tercer intento (`dim_cedis_oficina_v1`)
-- igual que si hubiera resuelto tipo_venta. Confirmado con datos: 6 de las 23
-- combinaciones bloqueadas por "sin CEDIS/tipo de venta" tenían el tipo de
-- venta esperando en `dim_cedis_oficina_v1`, nunca consultado porque
-- `dim_cedis_almacen_v1` encontraba un CEDIS por otro lado. Se quita ese join
-- (no aporta nada a esta CTE) y el tercer intento ahora depende de si
-- `tipo_venta` sigue sin resolver, no de si el segundo intento encontró algo
-- que aquí ni se usa. ~$0,26 M que antes caían en "sin CEDIS/tipo de venta".
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
        -- PAN incluida (2026-09-08): sus almacenes necesitan resolver
        -- tipo_venta igual que los de DBC. Verificado que `dm_cedis` los cubre
        -- al 100%, así que no abre ningún hueco nuevo.
        WHERE company_code IN ('DBC','PAN')) f
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc
         ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
         ON dc.tipo_venta IS NULL AND dco.oficina = f.sales_office
),

tarifas_h AS (
  SELECT
    BUKRS, WERKS, LGORT, VKBUR,
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

-- ─────────────────────────────────────────────────────────────────────────
-- ALCANCE DE LA SOCIEDAD PAN (agregado 2026-09-08)
--
-- Huevo se factura por DOS sociedades: DBC ($647 M en 2026) y PAN ($10.925 M).
-- Traer PAN entera sería incorrecto: la mayor parte de esa facturación no
-- genera comisión para los comisionistas de DBC.
--
-- EL FILTRO SE DECIDIÓ A PARTIR DE LA TABLA DE TARIFA OFICIAL DE SAP: entra
-- solo la facturación de PAN cuya llave centro+almacén+oficina existe en
-- `proan_ZTSD_OV_COM_H_20260829` con `BUKRS = 'PAN'`. Ese cruce ES la
-- definición de "genera comisión" -- si no hay tarifa, no hay comisión.
-- Medido: reduce $10.925 M -> $2.103 M de facturación en alcance.
--
-- LA PLANTA `PANF` NO BASTA como criterio, aunque lo parezca: el lado PAN de
-- la tarifa es 100% PANF (1 centro, 25 almacenes, 76 oficinas) y PAN3 no
-- aparece nunca ni en la tarifa ni en el mapeo de comisionistas -- pero
-- DENTRO de PANF solo $2.103 M de $7.422 M tiene tarifa. Filtrar por planta
-- sola metería 3,5 veces más facturación de la que corresponde.
alcance_pan AS (
  SELECT DISTINCT WERKS, LGORT, VKBUR
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_H_20260829`
  WHERE BUKRS = 'PAN'
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
  WHERE (
      f.company_code = 'DBC'
      -- PAN entra SOLO en huevo y SOLO donde su propia tarifa existe. Ver el
      -- comentario de `alcance_pan` para el porqué del criterio.
      OR (f.company_code = 'PAN'
          AND f.sales_division = 'H'
          AND EXISTS (SELECT 1 FROM alcance_pan k
                      WHERE k.WERKS = f.receiving_plant
                        AND k.LGORT = f.storage_location
                        AND k.VKBUR = f.sales_office))
    )
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
    ON f.gsber = 'H' AND f.bukrs = th.BUKRS
   AND f.werks = th.WERKS AND f.lgort = th.LGORT AND f.vkbur = th.VKBUR
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

-- 2026-09-08: TIPO DE VENTA (y por lo tanto la tarifa) SE TOMA DE LA PROPIA
-- TABLA DE TARIFA, no de `dim_cedis_v1`/`dim_cedis_oficina_v1`. Motivo: esa
-- dimensión es una fuente aparte que puede quedar desactualizada frente a la
-- tarifa oficial de SAP -- ya probado en huevo con un caso real (H719/0028:
-- para DBC decía "VTA EN RUTA" y sí correspondía, pero para PAN el mismo
-- almacén+oficina es "MED MAYOREO" -- dim_cedis no distingue sociedad y solo
-- acertaba para una de las dos). Encontrado también H701/0121 y H707/0106,
-- errados para ambas sociedades -- y muchos más una vez medido a fondo: en
-- total $110,4 M que caían en "sin tarifa para esa llave" tenían tarifa real
-- esperando bajo el tipo de venta correcto ($5,5 M de hueco genuino en huevo
-- se quedan sin tarifa igual -- ver comentario del encabezado del archivo).
--
-- Aplicado a las 3 divisiones donde la tarifa distingue tipo de venta/canal
-- por columnas (H, BO, IA) -- Leche y Abarrotes no tienen esa distinción en
-- su tabla de tarifa, así que ahí no hay nada que resolver y siguen igual.
-- Regla por SET: si dim_cedis apunta a una columna que SÍ tiene tarifa, se
-- respeta (cubre los sitios con más de una columna con valor -- 2 de 360
-- llaves en H, 0 en BO/IA -- donde la tarifa sola no alcanza para decidir).
-- Si dim_cedis no confirma nada (vacío o apunta a una columna vacía), se toma
-- la tarifa directo de la única columna con valor. En huevo, para H únicamente
-- se sobreescribe también el tipo de venta mostrado (es la fuente real de la
-- tarifa); en botana/alimento el tipo de venta mostrado sigue viniendo de
-- dim_cedis sin cambio (informativo, la tarifa ya no depende de él).
resuelto AS (
  SELECT
    *,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HSANJUAN_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HSANJUAN_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HSANJUAN_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HSANJUAN_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HSANJUAN_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HSANJUAN_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HSANJUAN_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HSANJUAN_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HSANJUAN_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HSANJUAN_ABASTOS AS tarifa)
      WHEN HSANJUAN_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HSANJUAN_RUTA    AS tarifa)
      WHEN HSANJUAN_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HSANJUAN_MENUDEO AS tarifa)
      WHEN HSANJUAN_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HSANJUAN_MAYOREO AS tarifa)
      WHEN HSANJUAN_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HSANJUAN_MMAY    AS tarifa)
      WHEN HSANJUAN_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HSANJUAN_ABASTOS AS tarifa)
    END AS HSANJUAN_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HPORTALES_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HPORTALES_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HPORTALES_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HPORTALES_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HPORTALES_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HPORTALES_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HPORTALES_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HPORTALES_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HPORTALES_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HPORTALES_ABASTOS AS tarifa)
      WHEN HPORTALES_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HPORTALES_RUTA    AS tarifa)
      WHEN HPORTALES_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HPORTALES_MENUDEO AS tarifa)
      WHEN HPORTALES_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HPORTALES_MAYOREO AS tarifa)
      WHEN HPORTALES_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HPORTALES_MMAY    AS tarifa)
      WHEN HPORTALES_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HPORTALES_ABASTOS AS tarifa)
    END AS HPORTALES_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HINDUSTRIA_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HINDUSTRIA_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HINDUSTRIA_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HINDUSTRIA_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HINDUSTRIA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HINDUSTRIA_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HINDUSTRIA_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HINDUSTRIA_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HINDUSTRIA_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HINDUSTRIA_ABASTOS AS tarifa)
      WHEN HINDUSTRIA_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HINDUSTRIA_RUTA    AS tarifa)
      WHEN HINDUSTRIA_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HINDUSTRIA_MENUDEO AS tarifa)
      WHEN HINDUSTRIA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HINDUSTRIA_MAYOREO AS tarifa)
      WHEN HINDUSTRIA_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HINDUSTRIA_MMAY    AS tarifa)
      WHEN HINDUSTRIA_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HINDUSTRIA_ABASTOS AS tarifa)
    END AS HINDUSTRIA_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HRANCHERO_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HRANCHERO_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HRANCHERO_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HRANCHERO_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HRANCHERO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HRANCHERO_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HRANCHERO_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HRANCHERO_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HRANCHERO_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HRANCHERO_ABASTOS AS tarifa)
      WHEN HRANCHERO_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HRANCHERO_RUTA    AS tarifa)
      WHEN HRANCHERO_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HRANCHERO_MENUDEO AS tarifa)
      WHEN HRANCHERO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HRANCHERO_MAYOREO AS tarifa)
      WHEN HRANCHERO_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HRANCHERO_MMAY    AS tarifa)
      WHEN HRANCHERO_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HRANCHERO_ABASTOS AS tarifa)
    END AS HRANCHERO_r,

    CASE
      WHEN canal = 'MENUDEO' AND CHOCOLATE_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOCOLATE_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CHOCOLATE_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOCOLATE_MAYOREO AS tarifa)
      WHEN CHOCOLATE_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOCOLATE_MENUDEO AS tarifa)
      WHEN CHOCOLATE_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOCOLATE_MAYOREO AS tarifa)
    END AS CHOCOLATE_r,
    CASE
      WHEN canal = 'MENUDEO' AND VAINILLA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VAINILLA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND VAINILLA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VAINILLA_MAYOREO AS tarifa)
      WHEN VAINILLA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VAINILLA_MENUDEO AS tarifa)
      WHEN VAINILLA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VAINILLA_MAYOREO AS tarifa)
    END AS VAINILLA_r,
    CASE
      WHEN canal = 'MENUDEO' AND CAJETA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CAJETA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CAJETA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CAJETA_MAYOREO AS tarifa)
      WHEN CAJETA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CAJETA_MENUDEO AS tarifa)
      WHEN CAJETA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CAJETA_MAYOREO AS tarifa)
    END AS CAJETA_r,
    CASE
      WHEN canal = 'MENUDEO' AND SWICH_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SWICH_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND SWICH_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SWICH_MAYOREO AS tarifa)
      WHEN SWICH_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SWICH_MENUDEO AS tarifa)
      WHEN SWICH_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SWICH_MAYOREO AS tarifa)
    END AS SWICH_r,
    CASE
      WHEN canal = 'MENUDEO' AND SW_ROLL_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SW_ROLL_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND SW_ROLL_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SW_ROLL_MAYOREO AS tarifa)
      WHEN SW_ROLL_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SW_ROLL_MENUDEO AS tarifa)
      WHEN SW_ROLL_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SW_ROLL_MAYOREO AS tarifa)
    END AS SW_ROLL_r,
    CASE
      WHEN canal = 'MENUDEO' AND BIG_CHO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_CHO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BIG_CHO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_CHO_MAYOREO AS tarifa)
      WHEN BIG_CHO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_CHO_MENUDEO AS tarifa)
      WHEN BIG_CHO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_CHO_MAYOREO AS tarifa)
    END AS BIG_CHO_r,
    CASE
      WHEN canal = 'MENUDEO' AND BIG_VAI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_VAI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BIG_VAI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_VAI_MAYOREO AS tarifa)
      WHEN BIG_VAI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_VAI_MENUDEO AS tarifa)
      WHEN BIG_VAI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_VAI_MAYOREO AS tarifa)
    END AS BIG_VAI_r,
    CASE
      WHEN canal = 'MENUDEO' AND VUALA_BOLD_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VUALA_BOLD_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND VUALA_BOLD_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VUALA_BOLD_MAYOREO AS tarifa)
      WHEN VUALA_BOLD_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VUALA_BOLD_MENUDEO AS tarifa)
      WHEN VUALA_BOLD_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VUALA_BOLD_MAYOREO AS tarifa)
    END AS VUALA_BOLD_r,
    CASE
      WHEN canal = 'MENUDEO' AND PINA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PINA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND PINA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PINA_MAYOREO AS tarifa)
      WHEN PINA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PINA_MENUDEO AS tarifa)
      WHEN PINA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PINA_MAYOREO AS tarifa)
    END AS PINA_r,
    CASE
      WHEN canal = 'MENUDEO' AND PMUERTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PMUERTO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND PMUERTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PMUERTO_MAYOREO AS tarifa)
      WHEN PMUERTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PMUERTO_MENUDEO AS tarifa)
      WHEN PMUERTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PMUERTO_MAYOREO AS tarifa)
    END AS PMUERTO_r,

    CASE
      WHEN canal = 'MENUDEO' AND CHOP_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOP_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CHOP_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOP_MAYOREO AS tarifa)
      WHEN CHOP_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOP_MENUDEO AS tarifa)
      WHEN CHOP_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOP_MAYOREO AS tarifa)
    END AS CHOP_r,
    CASE
      WHEN canal = 'MENUDEO' AND BALU_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALU_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BALU_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALU_MAYOREO AS tarifa)
      WHEN BALU_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALU_MENUDEO AS tarifa)
      WHEN BALU_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALU_MAYOREO AS tarifa)
    END AS BALU_r,
    CASE
      WHEN canal = 'MENUDEO' AND WOOFI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, WOOFI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND WOOFI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, WOOFI_MAYOREO AS tarifa)
      WHEN WOOFI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, WOOFI_MENUDEO AS tarifa)
      WHEN WOOFI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, WOOFI_MAYOREO AS tarifa)
    END AS WOOFI_r,
    CASE
      WHEN canal = 'MENUDEO' AND BALTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALTO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BALTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALTO_MAYOREO AS tarifa)
      WHEN BALTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALTO_MENUDEO AS tarifa)
      WHEN BALTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALTO_MAYOREO AS tarifa)
    END AS BALTO_r,
    CASE
      WHEN canal = 'MENUDEO' AND MIXI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, MIXI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND MIXI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, MIXI_MAYOREO AS tarifa)
      WHEN MIXI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, MIXI_MENUDEO AS tarifa)
      WHEN MIXI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, MIXI_MAYOREO AS tarifa)
    END AS MIXI_r,
    CASE
      WHEN canal = 'MENUDEO' AND BONGO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BONGO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BONGO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BONGO_MAYOREO AS tarifa)
      WHEN BONGO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BONGO_MENUDEO AS tarifa)
      WHEN BONGO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BONGO_MAYOREO AS tarifa)
    END AS BONGO_r
  FROM base
),

con_tarifa AS (
  SELECT
    * EXCEPT (
      HSANJUAN_r, HPORTALES_r, HINDUSTRIA_r, HRANCHERO_r,
      CHOCOLATE_r, VAINILLA_r, CAJETA_r, SWICH_r, SW_ROLL_r, BIG_CHO_r, BIG_VAI_r, VUALA_BOLD_r, PINA_r, PMUERTO_r,
      CHOP_r, BALU_r, WOOFI_r, BALTO_r, MIXI_r, BONGO_r
    ),
    CASE
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   THEN HSANJUAN_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  THEN HPORTALES_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' THEN HINDUSTRIA_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  THEN HRANCHERO_r.tarifa

      WHEN gsber = 'BO' AND SETNAME = 'CHOCOLATE'  THEN CHOCOLATE_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'VAINILLA'   THEN VAINILLA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'CAJETA'     THEN CAJETA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'SWICH'      THEN SWICH_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'SW_ROLL'    THEN SW_ROLL_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'BIG_CHO'    THEN BIG_CHO_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'BIG_VAI'    THEN BIG_VAI_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'VUALA_BOLD' THEN VUALA_BOLD_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'PINA'       THEN PINA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'PMUERTO'    THEN PMUERTO_r.tarifa

      WHEN gsber = 'IA' AND SETNAME = 'CHOP'  THEN CHOP_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BALU'  THEN BALU_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'WOOFI' THEN WOOFI_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BALTO' THEN BALTO_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'MIXI'  THEN MIXI_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BONGO' THEN BONGO_r.tarifa

      WHEN gsber = 'L' AND SETNAME = 'LENTERA' THEN LENTERA
      WHEN gsber = 'L' AND SETNAME = 'LLIGHT'  THEN LLIGHT
      WHEN gsber = 'L' AND SETNAME = 'LDESLAC' THEN LDESLAC

      WHEN gsber = 'A' THEN tarifa_a
    END AS tarifa,
    -- Tipo de venta resuelto: para H, viene del mismo struct que resolvió la
    -- tarifa (self-healed contra dm_cedis). Para BO/IA/L/A no cambia -- su
    -- tabla de tarifa no distingue más que canal (BO/IA) o nada (L/A), así
    -- que el tipo de venta que se muestra sigue siendo el de dm_cedis.
    CASE
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   THEN HSANJUAN_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  THEN HPORTALES_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' THEN HINDUSTRIA_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  THEN HRANCHERO_r.tipo_venta
      ELSE tipo_venta
    END AS tipo_venta_resuelto
  FROM resuelto
),

-- Cobro: mismas dos CTEs que v1_flujo_producto_dbc_prototipo_v2.sql. Denominador
-- del prorrateo (con_impuestos) y el pago por factura (document_category='M').
factura_totales AS (
  SELECT
    billing_document,
    SUM(CAST(amount_total_mxn AS FLOAT64)) AS con_impuestos
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  WHERE company_code IN ('DBC','PAN') AND document_category = 'M'
  GROUP BY billing_document
),

-- debit_lg: lado de BSAD que trae la factura contra la que se aplicó el
-- cobro (el otro lado, credit_lg, es la entrada del pago en sí). SUM en vez
-- de ANY_VALUE porque puede haber más de una línea por factura (pagos
-- parciales en fechas distintas).
pago_factura AS (
  SELECT
    VBELN_billing_document AS billing_document,
    MIN(AUGDT_clearing_dt) AS fecha_cobro,
    SUM(DMBTR_amount_in_local_currency) AS pagado
  FROM `proan-quantrue.D30_INTEGRATION.sap_bsad_cleared_items`
  WHERE BUKRS_company_code IN ('DBC','PAN')
    AND debit_lg
    AND VBELN_billing_document IS NOT NULL AND VBELN_billing_document != ''
    AND AUGDT_clearing_dt >= '2026-01-01'
  GROUP BY VBELN_billing_document
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
  t.tipo_venta_resuelto AS tipo_venta,
  t.canal,
  t.cantidad,
  t.importe_mxn,
  t.tarifa,
  CASE
    WHEN t.tarifa              IS NOT NULL THEN 'OK'
    WHEN t.SETNAME              IS NULL    THEN 'SIN_SET'
    WHEN t.tipo_venta_resuelto  IS NULL    THEN 'SIN_CEDIS'
    ELSE 'SIN_TARIFA'
  END AS status,

  ROUND(t.cantidad * t.tarifa, 2) AS comision_mxn,

  p.billing_document IS NOT NULL AS se_cobro,
  ROUND(t.importe_mxn * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2) AS monto_cobrado,
  ROUND(t.cantidad    * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2) AS cantidad_cobrada,
  -- Comisión "con cobro registrado": tarifa × lo efectivamente cobrado. 0 si
  -- nada se ha cobrado todavía (no NULL: NULL es "sin tarifa", 0 es "con
  -- tarifa, sin cobro").
  ROUND(t.cantidad * t.tarifa * COALESCE(SAFE_DIVIDE(p.pagado, ft.con_impuestos), 0), 2) AS comision_cobrada,
  p.fecha_cobro
FROM con_tarifa t
LEFT JOIN factura_totales ft ON ft.billing_document = t.billing_document
LEFT JOIN pago_factura p     ON p.billing_document   = t.billing_document
ORDER BY t.billing_date DESC, t.billing_document, t.item_number;
