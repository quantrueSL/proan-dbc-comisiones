-- =============================================================================
-- GOLD · Flujo de producto DBC — agregado diario para el dashboard
-- =============================================================================
-- Sale de DBC_silver_flujo_producto (ejecutar esa primero).
--
-- Grano: fase × fecha × división × CEDIS × tipo de venta × unidad.
-- Es lo que lee la pantalla de flujo de producto: unos pocos MB, instantáneo.
--
-- OJO — ESTA AGREGACIÓN ESTÁ DUPLICADA. La vista
-- `ZZ_PRUEBAS.v1_flujo_producto_dbc_resumen_diario` de Silvana hace exactamente
-- lo mismo, pero leyendo su vista de detalle (8,98 GiB por consulta). Aquí se
-- repite el GROUP BY para poder salir de la tabla silver, que es lo que hace
-- barato el dashboard. Si Silvana cambia su agregación, hay que replicar el
-- cambio aquí. La lógica de verdad —el UNION ALL de las tres capas— sigue
-- siendo suya y no está duplicada.
--
-- `unidad` VA EN EL GROUP BY A PROPÓSITO: `cantidad` viene en unidades mezcladas
-- (CS, PZA, PAQ, SAC, KG...), así que sumarla sin separar por unidad mezclaría
-- cosas no comparables. La que sí es sumable entre unidades es
-- `cantidad_cajas_total`, pero solo existe para "facturado" (NULL en vendido y
-- cobrado, porque sap_pago no llega a nivel de material y VBAP no tiene el
-- equivalente a stockkeeping_units).
--
-- Quien pinte esto en pantalla: no sumes `cantidad_total` entre unidades.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`
PARTITION BY fecha
CLUSTER BY cedis, division_code
AS
SELECT
  fase,
  fecha,
  division_code,
  division,
  cedis,
  tipo_venta,
  unidad,
  COUNT(*) AS num_lineas,
  SUM(cantidad) AS cantidad_total,
  SUM(cantidad_cajas) AS cantidad_cajas_total,
  SUM(monto) AS monto_total
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto`
GROUP BY fase, fecha, division_code, division, cedis, tipo_venta, unidad;
