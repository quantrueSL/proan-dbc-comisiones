-- =============================================================================
-- INCREMENTAL · DBC_silver_flujo_producto
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en
-- ../../Historico/D50_AGGREGATE/DBC_silver_flujo_producto.sql y, sobre todo, en
-- la vista que materializa (v1_flujo_producto_dbc.sql, misma carpeta) — este
-- archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `fecha`.
--
-- OJO CON QUÉ SIGNIFICA `fecha` AQUÍ, porque no es lo mismo en las tres fases:
-- en 'vendido' es la fecha del pedido, en 'facturado' la de la factura y en
-- 'cobrado' la de compensación. Eso juega a favor: un pago que llega tarde cae
-- en una partición RECIENTE (la de su compensación), así que la ventana lo
-- coge siempre. El caso que de verdad necesita ventana larga es 'facturado',
-- donde una factura cancelada desaparece de una partición vieja.
--
-- Este INSERT es POSICIONAL y esta tabla es `SELECT *` de la vista, así que su
-- orden de columnas es el de la vista. Si se añade o reordena una columna en
-- v1_flujo_producto_dbc.sql hay que recrear la tabla con el gemelo completo,
-- no basta con este archivo. Si falla con "Inserted row has wrong column
-- count", es exactamente eso.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D50_AGGREGATE.DBC_silver_flujo_producto`
WHERE fecha >= ventana_desde;

INSERT INTO `proan-quantrue.D50_AGGREGATE.DBC_silver_flujo_producto`
SELECT *
FROM `proan-quantrue.D50_AGGREGATE.v1_flujo_producto_dbc`
WHERE fecha >= ventana_desde;   -- <- alcance incremental

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D50_AGGREGATE.DBC_silver_flujo_producto`
  WHERE fecha >= ventana_desde
) > 0 AS 'DBC_silver_flujo_producto: la ventana quedó vacía tras el refresco';
