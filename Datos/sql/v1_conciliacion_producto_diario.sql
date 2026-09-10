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
--
-- `sociedad` agregada 2026-09-08 (al integrar PAN en huevo): 11 comisionistas
-- de huevo tienen operación en DBC Y en PAN (Genaro entre ellos) -- sin esta
-- columna en la llave, sus productos de las dos sociedades se sumaban en una
-- sola fila.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`
PARTITION BY fecha
CLUSTER BY division_code, comisionista
AS
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
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_factura_linea`
GROUP BY fecha, sociedad, division_code, division, cedis, oficina, comisionista_id, comisionista, tipo_venta,
         matnr, descripcion, unidad_venta, unidad_tarifa;
