-- =============================================================================
-- INCREMENTAL · DBC_gold_flujo_producto_diario
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa (por qué se agrega aquí y no se lee la vista
-- resumen, qué significa cada columna del GROUP BY, por qué `division_en_operacion`
-- se calcula en esta capa y no en la silver) en
-- ../../Historico/D60_REPORTING/DBC_gold_flujo_producto_diario.sql — este
-- archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `fecha`. Tiene que ser el MISMO valor
-- que en el gemelo de la silver (D50_AGGREGATE/DBC_silver_flujo_producto.sql):
-- si esta ventana fuera más corta, esta gold conservaría días que la silver ya
-- no tiene y las dos capas se separarían sin dar ningún error.
--
-- ORDEN EN EL DAG: después de DBC_silver_flujo_producto.
--
-- Este INSERT es POSICIONAL. El orden es:
--   fase, sociedad, fecha, division_code, division, cedis, tipo_venta,
--   cedis_origen, almacen_central, division_en_operacion, unidad, num_lineas,
--   cantidad_total, cantidad_cajas_total, monto_total
-- y tiene que coincidir con el esquema que crea el gemelo. Si falla con
-- "Inserted row has wrong column count", la tabla tiene un esquema viejo: hay
-- que recrearla con la versión completa.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D60_REPORTING.DBC_gold_flujo_producto_diario`
WHERE fecha >= ventana_desde;

INSERT INTO `proan-quantrue.D60_REPORTING.DBC_gold_flujo_producto_diario`
SELECT
  fase,
  sociedad,
  fecha,
  division_code,
  division,
  cedis,
  tipo_venta,
  cedis_origen,
  almacen_central,
  division_code IN ('H', 'BO', 'IA', 'A', 'L') AS division_en_operacion,
  unidad,
  COUNT(*) AS num_lineas,
  SUM(cantidad) AS cantidad_total,
  SUM(cantidad_cajas) AS cantidad_cajas_total,
  SUM(monto) AS monto_total
FROM `proan-quantrue.D50_AGGREGATE.DBC_silver_flujo_producto`
WHERE fecha >= ventana_desde   -- <- alcance incremental
GROUP BY fase, sociedad, fecha, division_code, division, cedis, tipo_venta, cedis_origen,
         almacen_central, division_en_operacion, unidad;

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D60_REPORTING.DBC_gold_flujo_producto_diario`
  WHERE fecha >= ventana_desde
) > 0 AS 'DBC_gold_flujo_producto_diario: la ventana quedó vacía tras el refresco';
