-- =============================================================================
-- SILVER · Flujo de producto DBC — un renglón por evento
-- =============================================================================
-- Materializa la vista `D50_AGGREGATE.v1_flujo_producto_dbc`
-- (v1_flujo_producto_dbc.sql, en esta misma carpeta — es la fuente de verdad).
--
-- POR QUÉ MATERIALIZAR, con números medidos:
--   Consultar su vista escanea 8,98 GiB, porque rehace el UNION ALL de las tres
--   capas (vendido + facturado + cobrado) desde las tablas SAP en cada consulta.
--   Con esta tabla, cualquier agregado posterior escanea solo unos cientos de MB.
--   Es la diferencia entre que cada tabla gold nueva cueste 9 GiB o medio giga —
--   y harán falta más: comisiones necesitará la suya agrupada por SET cuando
--   llegue el export de GS03, y conciliación otra distinta.
--
-- PARTICIÓN Y CLUSTERING: el dashboard filtra por periodo y por CEDIS, así que
-- particionar por `fecha` y agrupar por `cedis` hace que BigQuery lea solo las
-- particiones pedidas. Misma convención que el resto del proyecto (por ejemplo
-- GOLD_ALERTAS_MENSUAL de Rentabilidad, particionada por mes y clusterizada).
--
-- ORDEN: esta primero, luego DBC_gold_flujo_producto_diario.sql, que sale de
-- esta. Las dos juntas son el DAG diario cuando se orqueste en Airflow. Ojo:
-- `v1_flujo_producto_dbc.sql` (que crea la vista de la que sale esto, y las
-- dimensiones que ella cruza) va ANTES de las dos — es donde vive la lógica.
--
-- Sigue siendo un `SELECT *` a propósito: la lógica de mapeo está en la vista,
-- así que las columnas nuevas de allí (por ejemplo `cedis_origen`, que dice si
-- el CEDIS salió del cruce almacén+oficina o del fallback por oficina sola)
-- llegan aquí sin tocar este fichero.
--
-- DATASET: D50_AGGREGATE, con prefijo DBC_ (confirmado con el senior el
-- 2026-09-23). La gold que sale de aquí va a D60_REPORTING. Es un dataset
-- compartido entre productos del grupo, aislado por prefijo de tabla.
--
-- Coste: ~0,06 USD por ejecución. Un refresco diario sale por menos de 2 USD/mes,
-- así que no compensa complicarlo con cargas incrementales.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.D50_AGGREGATE.DBC_silver_flujo_producto`
PARTITION BY fecha
CLUSTER BY fase, cedis, division_code
AS
SELECT * FROM `proan-quantrue.D50_AGGREGATE.v1_flujo_producto_dbc`;
