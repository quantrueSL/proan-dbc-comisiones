-- =============================================================================
-- INCREMENTAL · DBC_gold_conciliacion_pago_linea
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/D60_REPORTING/DBC_gold_conciliacion_pago_linea.sql
-- -- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `fecha_pago`. Mismo valor de `ventana_desde` que en los otros
-- archivos de esta rama.
--
-- ORDEN EN EL DAG: lee `DBC_gold_conciliacion_pago_documento`, así que corre DESPUÉS de que esa tabla haya
-- recargado su ventana (paso 4, junto a `producto_diario`).
--
-- Este INSERT es POSICIONAL. El orden es:
--   sociedad, doc_id, comisionista_id, division_code, fecha_pago, pedido, posicion, texto_posicion, linea,
--   importe
-- y tiene que coincidir con el esquema que crea el gemelo.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_linea`
WHERE fecha_pago >= ventana_desde;

INSERT INTO `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_linea`
WITH miro AS (
  -- Factura de MIRO de cada documento de pago: AWKEY = factura MM (10) + ejercicio (4).
  SELECT DISTINCT CONCAT(BUKRS, '|', GJAHR, '|', BELNR) AS doc_id, SUBSTR(AWKEY, 1, 14) AS factura_mm
  FROM `proan-quantrue.D10_POSTPROCESSING.sap_BKPF_*`
  WHERE AWTYP = 'RMRP'
),
posicion AS (
  SELECT EBELN_OrdenCompra AS pedido, EBELP_Posicion AS posicion, ANY_VALUE(TXZ01_TextoBreve) AS texto_posicion
  FROM `proan-quantrue.D30_INTEGRATION.sap_purchasing_orders`
  GROUP BY 1, 2
),
-- Línea de factura (VGABE 2) del pedido: una por posición y línea de distribución (ZEKKN).
factura AS (
  SELECT CONCAT(BELNR, GJAHR) AS factura_mm, EBELN AS pedido, EBELP AS posicion, ZEKKN AS linea,
    SUM(IF(SHKZG = 'S', DMBTR, -DMBTR)) AS importe
  FROM `proan-quantrue.D30_INTEGRATION.sap_ekbe`
  WHERE VGABE = '2'
  GROUP BY 1, 2, 3, 4
)
-- El orden de columnas es el contrato con el gemelo de Airflow (INSERT posicional).
SELECT
  p.sociedad,
  p.doc_id,
  p.comisionista_id,
  p.division_code,
  p.fecha_pago,
  f.pedido,
  f.posicion,
  o.texto_posicion,
  f.linea,
  CAST(f.importe AS NUMERIC) AS importe
FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento` p
JOIN miro m ON m.doc_id = p.doc_id
JOIN factura f ON f.factura_mm = m.factura_mm
LEFT JOIN posicion o ON o.pedido = f.pedido AND o.posicion = f.posicion;
