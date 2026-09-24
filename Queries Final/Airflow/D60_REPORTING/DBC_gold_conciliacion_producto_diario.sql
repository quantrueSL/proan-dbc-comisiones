-- =============================================================================
-- INCREMENTAL · DBC_gold_conciliacion_producto_diario
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/D60_REPORTING/DBC_gold_conciliacion_producto_diario.sql
-- -- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `fecha`. Mismo valor de
-- `ventana_desde` que en los otros seis archivos de esta rama: si una gold usa
-- ventana más corta que su silver, conserva filas que la silver ya no tiene.
--
-- ORDEN EN EL DAG: ULTIMA de la cadena. Sale de otra GOLD (DBC_gold_conciliacion_factura_linea),
-- no de la silver: si corre en paralelo con las demas se alimenta de la ventana
-- vieja. Tiene que esperar a que factura_linea termine.
--
-- Este INSERT es POSICIONAL. El orden es:
--   fecha, sociedad, division_code, division, cedis, oficina, comisionista_id,
--   comisionista, tipo_venta, matnr, descripcion, unidad_venta, unidad_tarifa,
--   tarifa, num_lineas, cantidad_venta_total, monto_total, cantidad_base_total,
--   comision_total, lineas_sin_comision
-- y tiene que coincidir con el esquema que crea el gemelo. Si falla con
-- "Inserted row has wrong column count", la tabla tiene un esquema viejo: hay
-- que recrearla con la versión completa.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`
WHERE fecha >= ventana_desde;

INSERT INTO `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`
SELECT
  fecha, sociedad, division_code, division, cedis, oficina, comisionista_id, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, unidad_tarifa,
  ANY_VALUE(tarifa)             AS tarifa,
  COUNT(*)                      AS num_lineas,
  SUM(cantidad_venta)           AS cantidad_venta_total,
  SUM(monto)                    AS monto_total,
  SUM(cantidad_base)            AS cantidad_base_total,
  SUM(comision)                 AS comision_total,
  COUNTIF(comision_estado != 'calculada') AS lineas_sin_comision
FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_factura_linea`
WHERE fecha >= ventana_desde   -- <- alcance incremental
GROUP BY fecha, sociedad, division_code, division, cedis, oficina, comisionista_id, comisionista, tipo_venta,
         matnr, descripcion, unidad_venta, unidad_tarifa;

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`
  WHERE fecha >= ventana_desde
) > 0 AS 'DBC_gold_conciliacion_producto_diario: la ventana quedó vacía tras el refresco';
