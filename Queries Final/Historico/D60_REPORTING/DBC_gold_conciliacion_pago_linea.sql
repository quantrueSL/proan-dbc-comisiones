-- Conciliación por cortes — el pago de cada documento abierto por línea del pedido (pasivo temporal)
-- =============================================================================
-- Un renglón por documento de pago (`doc_id`, ver `DBC_gold_conciliacion_pago_documento`) × posición del
-- pedido de compra × línea de distribución (ZEKKN). Es el detalle de las líneas "Pasivo Temporal" del
-- documento de SAP: la factura de comisión (MIRO) se carga contra el pedido anual del comisionista, que
-- tiene una posición por semana ("COMISION VUALA SEMANA 18-24 JULIO") y varias líneas por posición.
--
-- LO QUE SE SABE (medido 2026-10-29 con José Guadalupe Campos, Botana): la suma de las líneas de un
-- documento es exactamente su `pagado` (999 de 1,000 documentos con detalle cuadran a ±$1) y en Botana cada
-- posición trae 3 líneas por familia de producto: 01 = VUALA en tira, 02 = SW (cake y roll, SIN los 4 SKUs
-- 17126, 17401, 17402 y 17630 hasta agosto), 03 = BIG. Falta confirmar qué significa ZEKKN en las demás
-- divisiones (Huevo trae hasta 2 líneas por posición; Croqueta y Leche, 1).
--
-- COBERTURA: ~75% de los documentos (937 de 1,246 en Botana, 806 de 1,068 en Huevo DBC, 999 de 1,266 en
-- PAN). El resto no tiene factura de MIRO en BKPF (AWTYP = 'RMRP'), es decir, no salió de un pedido.
--
-- FUENTES: `D10_POSTPROCESSING.sap_BKPF_*` (documento FI -> factura MM), `D30_INTEGRATION.sap_ekbe`
-- (historial del pedido, solo VGABE 2 = factura) y `D30_INTEGRATION.sap_purchasing_orders` (texto de la
-- posición). Llave de unión con el pago: `doc_id`.
--
-- PARTICIÓN POR `fecha_pago`, igual que `pago_documento`.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_linea`
PARTITION BY fecha_pago
CLUSTER BY sociedad, comisionista_id, division_code
AS
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
