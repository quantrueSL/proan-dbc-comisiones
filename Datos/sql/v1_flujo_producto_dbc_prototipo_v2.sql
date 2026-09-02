-- =============================================================================
-- PROTOTIPO v2 — facturado + cobrado en una sola fila por línea de factura.
-- =============================================================================
-- Por ahora SOLO facturado + cobrado, sin vendido -- vendido se vuelve a meter
-- después, cuando esto quede validado.
--
-- Reemplaza la idea de "cobrado" como tercera rama del UNION ALL con su propia
-- resolución de CEDIS (factura_sitio_v1 + desempate alfabético de almacén).
-- En vez de eso: se parte de facturado (que ya trae el sitio real de cada
-- línea) y se le pegan tres columnas de cobro, prorrateando el pago de la
-- factura entre sus líneas según el peso de cada una en el monto total.
--
-- QUÉ RESUELVE, con datos reales medidos en el prototipo:
--   - Factura 2071163278 (2 almacenes, $301,178.11): hoy el 100% se le
--     atribuye a un solo almacén (DG01) por el desempate alfabético de
--     `factura_sitio_v1`, y el otro (DG03, el 92% real) se queda en $0.
--     Con este diseño cada almacén se queda con lo suyo: DG03 -> $277,270.89,
--     DG01 -> $23,907.22 -- exacto contra facturado, sin desempate.
--   - Factura 2071257917 (5 líneas, 2 materiales): hoy "cobrado" da
--     `material_number = NULL` (se colapsa a 1 fila). Aquí cada línea
--     conserva su material, así que el cobro también queda por material
--     (como estimación proporcional -- SAP no dice cuánto del pago fue para
--     cada material, pero es mejor que no tener nada).
--   - `document_category = 'M'`: la vista actual nunca filtra esto del lado
--     de facturado (solo del lado de cobrado, sobre sap_pago). Sin el
--     filtro, "facturado" mezclaba cancelaciones (N, -$109.4M en 2026) y
--     notas de crédito (O, -$10.0M) con facturas reales -- 7,405 filas
--     negativas en total. Con el filtro: 1,923,020 filas, $2,240,616,887.64,
--     y solo 17 filas negativas (ajustes menores, no vale la pena perseguirlas).
--
-- QUÉ CAMBIA DE ESTRUCTURA: ya no hay fila 'cobrado' aparte -- pasa a ser
-- tres columnas sobre la fila de 'facturado' (`se_cobro`, `monto_cobrado`,
-- `cajas_cobradas`, `fecha_cobro`). `factura_sitio_v1` ya no hace falta -- se
-- elimina.
--
-- LO QUE SE PIERDE, y hay que decidir si importa: el diseño de hoy tiene una
-- tercera rama que arranca de `sap_pago` (no de facturado), así que un pago
-- cuya factura no aparece en facturado igual sale (con `monto_confiable =
-- FALSE`). Aquí, al arrancar de facturado, ese pago no tendría fila donde
-- colgarse y desaparecería. Medido: hoy son CERO casos (las 39,332 facturas
-- cobradas de 2026 tienen su factura en facturado), así que hoy no pierde
-- nada real -- pero si algún día aparece un pago sin factura, se cae en
-- silencio en vez de marcarse. Si eso importa, se puede agregar de vuelta como
-- una rama aparte solo para esos huérfanos.
-- SOLO LECTURA -- es un SELECT suelto, no crea ni reemplaza nada en BigQuery.
-- =============================================================================
WITH plantas_dbc AS (
  -- Redundante contra `company_code = 'DBC'` (mismo motivo que en la vista
  -- actual), se deja por paridad de comportamiento mientras se valida.
  SELECT planta FROM UNNEST([
    'DBCF','DBC1','DBC3','H7LA','H7L1','H7L2','H7SL','H7SI','H7AG','H7SM',
    'H7QU','H7CE','H7SA','H7MI','H7MO','H7UR','H7ZA','H7IR','H7SJ','H7DU','H7TX'
  ]) AS planta
),

-- Denominador del prorrateo: el total de la factura (todas sus líneas, sin
-- filtro de fecha) en neto y con impuestos. Ya NO hace falta `cajas` aparte
-- aquí -- cada línea ya trae su propio `stockkeeping_units`.
-- document_category = 'M': solo factura real. Sin este filtro se mezclaban
-- cancelaciones (N, -$109.4M) y notas de crédito (O, -$10.0M) con facturas de
-- verdad -- eran negativos legítimos de SAP, pero no debían sumarse aquí como
-- si fueran ventas. Mismo filtro que ya usa pago_factura_v1 sobre sap_pago,
-- ahora aplicado también del lado de facturado (antes solo estaba de un lado).
factura_totales_v1 AS (
  SELECT
    billing_document,
    SUM(CAST(amount_mxn AS FLOAT64)) AS neto,
    SUM(CAST(amount_total_mxn AS FLOAT64)) AS con_impuestos
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  WHERE company_code = 'DBC'
    AND document_category = 'M'
  GROUP BY billing_document
),

-- Un renglón por factura cobrada (mismo criterio que antes: ANY_VALUE es
-- seguro porque no hay cobros parciales -- sección 4 del borrador). Ya no
-- necesita `business_area_code`/`distribution_channel` propios: facturado
-- ya trae división y canal por línea, no hace falta heredarlos del pago.
pago_factura_v1 AS (
  SELECT
    billing_document,
    MIN(CAST(clearing_date AS DATE)) AS fecha_cobro,
    ANY_VALUE(CAST(paid_amount_mxn AS FLOAT64)) AS pagado
  FROM `proan-quantrue.D50_AGGREGATE_CHATBI.sap_pago`
  WHERE company_code = 'DBC'
    AND document_category = 'M'
    AND CAST(clearing_date AS DATE) >= '2026-01-01'
  GROUP BY billing_document
)

-- Facturado + cobrado ----------------------------------------------------
-- Cada línea de factura trae su propio sitio (ya no hace falta
-- factura_sitio_v1) y, si la factura se cobró, su parte proporcional del pago.
SELECT
  CAST(f.billing_date AS DATE) AS fecha,
  CAST(f.billing_document AS STRING) AS documento,
  f.item_number AS linea,
  f.sales_division AS division_code,
  ba.business_area_name AS division,
  f.distribution_channel AS canal_code,
  COALESCE(dc.cedis, dal.cedis, dma.cedis, dco.cedis) AS cedis,
  COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
  CASE WHEN dc.cedis IS NOT NULL THEN 'almacen+oficina'
       WHEN dal.cedis IS NOT NULL THEN 'solo almacen'
       WHEN dma.cedis IS NOT NULL THEN 'lista de nombres'
       WHEN dco.cedis IS NOT NULL THEN 'solo oficina'
  END AS cedis_origen,
  f.storage_location IN ('BO28', 'BO01', 'H723', 'H793') AS almacen_central,
  -- Mismo criterio que v1_comision_dbc.sql (línea ~502): el cliente confirmó
  -- el 26/08/2026 que estas 4 oficinas son venta directa o bodega, no venta
  -- con comisionista -- se marcan (no se filtran) por la misma razón que
  -- almacen_central: para poder auditar cuánto se está dejando fuera sin que
  -- el total deje de cuadrar. La quinta oficina de esa conversación, 0227
  -- (Celaya Genaro, botana), sigue sin respuesta del cliente -- no se marca
  -- aquí todavía.
  f.sales_office IN ('0001', '0174', '0175', '0181') AS oficina_venta_directa,
  f.sales_office AS oficina,
  f.receiving_plant AS planta,
  f.storage_location AS almacen,
  f.material_number AS material_number,
  CAST(f.invoiced_quantity AS FLOAT64) AS cantidad,
  f.sales_unit AS unidad,
  CAST(f.stockkeeping_units AS FLOAT64) AS cantidad_cajas,
  CAST(f.amount_mxn AS FLOAT64) AS monto,
  p.billing_document IS NOT NULL AS se_cobro,
  -- Prorrateo: la fracción de la factura que se pagó (pagado / total con
  -- impuestos, sección 4 del borrador) aplicada al monto/cajas DE ESTA LÍNEA
  -- -- ya no a un total sintético de la factura completa.
  ROUND(CAST(f.amount_mxn AS FLOAT64) * SAFE_DIVIDE(p.pagado, t.con_impuestos), 2) AS monto_cobrado,
  ROUND(CAST(f.stockkeeping_units AS FLOAT64) * SAFE_DIVIDE(p.pagado, t.con_impuestos), 2) AS cajas_cobradas,
  p.fecha_cobro AS fecha_cobro
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = f.sales_division
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
       ON dc.cedis IS NULL AND dal.almacen = f.storage_location
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_nombre_v1` dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = f.storage_location
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = f.receiving_plant)
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
       ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL
      AND dco.oficina = f.sales_office
LEFT JOIN factura_totales_v1 t ON t.billing_document = f.billing_document
LEFT JOIN pago_factura_v1 p    ON p.billing_document = f.billing_document
WHERE f.receiving_plant IN (SELECT planta FROM plantas_dbc)
  AND f.company_code = 'DBC'
  AND f.document_category = 'M'   -- excluye cancelaciones (N) y notas de crédito (O) -- ver comentario de factura_totales_v1
  AND f.sales_division IN ('H', 'BO', 'IA', 'A', 'L')   -- las 5 divisiones activas de DBC (mismo filtro que v1_comision_dbc.sql) -- excluye DG/DH/CM/CE/DC/S/CP/DA, que no son negocio de DBC
  AND CAST(f.billing_date AS DATE) BETWEEN '2026-01-01' AND CURRENT_DATE();
