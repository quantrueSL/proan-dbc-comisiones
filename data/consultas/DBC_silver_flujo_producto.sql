-- =============================================================================
-- SILVER · Flujo de producto DBC — un renglón por evento
-- =============================================================================
-- Materializa la vista `ZZ_PRUEBAS.v1_flujo_producto_dbc` de Silvana
-- (Datos/sql/v1_flujo_producto_dbc.sql, fuente de verdad — no se toca).
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
-- ZZ_PRUEBAS.GOLD_ALERTAS_MENSUAL, particionada por mes y clusterizada).
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
-- DATASET: ZZ_PRUEBAS mientras dure la fase de pruebas, que es donde Silvana
-- dejó sus vistas. Al validarse, esta tabla va a D50_AGGREGATE (staging) y la
-- gold a D60_REPORTING, como en proan-hidrocarburos.
--
-- Coste: ~0,06 USD por ejecución. Un refresco diario sale por menos de 2 USD/mes,
-- así que no compensa complicarlo con cargas incrementales.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto`
PARTITION BY fecha
CLUSTER BY fase, cedis, division_code
AS
SELECT * FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`;
