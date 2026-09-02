-- =============================================================================
-- Conciliación por comisionista — detalle por producto, grano DIARIO.
-- Fuente: `DBC_gold_conciliacion_factura_linea` (grano línea de factura, con
-- toda la lógica de enriquecimiento -- ver ese archivo). Aquí solo se agrega
-- por día, sin duplicar esa lógica.
--
-- Sin columnas de cobro a propósito -- decisión de Silvana (2026-09-02): en
-- pausa perseguir cobro mientras se arma la presentación. Si esto cambia,
-- las columnas ya existen en `DBC_gold_conciliacion_factura_linea` y solo
-- hace falta sumarlas aquí.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`
PARTITION BY fecha
CLUSTER BY division_code, comisionista
AS
SELECT
  fecha, division_code, division, cedis, oficina, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, base_unidad,
  ANY_VALUE(tarifa)             AS tarifa,
  COUNT(*)                      AS num_lineas,
  SUM(cantidad_venta)           AS cantidad_venta_total,
  SUM(monto)                    AS monto_total,
  SUM(cantidad_base)            AS cantidad_base_total,
  SUM(comision)                 AS comision_total,
  COUNTIF(comision_estado != 'calculada') AS lineas_sin_comision
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_factura_linea`
GROUP BY fecha, division_code, division, cedis, oficina, comisionista, tipo_venta,
         matnr, descripcion, unidad_venta, base_unidad;
