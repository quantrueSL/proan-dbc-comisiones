-- =============================================================================
-- GOLD · Flujo de producto DBC — agregado diario para el dashboard
-- =============================================================================
-- Sale de DBC_silver_flujo_producto (ejecutar esa primero).
--
-- Grano: fase × fecha × división × CEDIS × tipo de venta × origen del CEDIS ×
-- almacén central (sí/no) × división en operación (sí/no) × unidad.
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
-- `cantidad_cajas_total`, que ya viene informada en las TRES fases: de
-- `stockkeeping_units` en facturado, de la conversión UMVKZ/UMVKN en vendido, y
-- prorrateando las cajas de la factura por la proporción cobrada en cobrado
-- (ver v1_flujo_producto_dbc.sql). Ojo con el nombre: mide cantidad en la
-- unidad base del material, que no siempre es una caja.
--
-- Quien pinte esto en pantalla: no sumes `cantidad_total` entre unidades.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_flujo_producto_diario`
PARTITION BY fecha
CLUSTER BY cedis, division_code
AS
SELECT
  fase,
  -- 2026-09-10: DBC o PAN (huevo, alcance_pan) -- ver v1_flujo_producto_dbc.sql
  -- sección 2. "Vendido" siempre es 'DBC'.
  sociedad,
  fecha,
  division_code,
  division,
  cedis,
  tipo_venta,
  -- De dónde salió el CEDIS: 'almacen+oficina' (el cruce completo) o
  -- 'solo oficina' (el fallback de la sección 1b de v1_flujo_producto_dbc).
  -- Va en el GROUP BY porque si no, al agregar se pierde: un CEDIS que mezcla
  -- las dos procedencias quedaría indistinguible de uno cruzado entero y ya no
  -- se podría volver al resultado sin fallback. Hoy el backend no lee esta
  -- columna -- la pantalla enseña lo mismo que antes, con más CEDIS asignado.
  cedis_origen,
  -- Los cuatro almacenes centrales que el cliente confirmó el 25/08/2026 que no
  -- pasan por CEDIS ni generan comisión. Entra en el GROUP BY para que la
  -- pantalla pueda dejarlos fuera sin perder la posibilidad de sumarlos: si se
  -- borraran, nadie podría comprobar cuánto se está excluyendo.
  almacen_central,
  -- Divisiones que el cliente confirmó tener en operación (correo del
  -- 25/08/2026): huevo, botana, croqueta, abarrotes y leche. Las demás —DG, DH,
  -- CM, CE, DC, S, CP— están configuradas en SAP pero las llevan otros
  -- departamentos, y se les nota: entre el 82% y el 100% de su importe no cruza
  -- con ningún CEDIS, porque nadie mantiene ese mapeo. Son $500 M que la
  -- pantalla deja fuera.
  --
  -- Se calcula AQUÍ y no en la vista a propósito: es un criterio de alcance de
  -- lo que se enseña, no una propiedad de la línea. La silver sigue teniéndolo
  -- todo, así que el día que quieran verlas basta con dejar de filtrar.
  division_code IN ('H', 'BO', 'IA', 'A', 'L') AS division_en_operacion,
  unidad,
  COUNT(*) AS num_lineas,
  SUM(cantidad) AS cantidad_total,
  SUM(cantidad_cajas) AS cantidad_cajas_total,
  SUM(monto) AS monto_total
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto`
GROUP BY fase, sociedad, fecha, division_code, division, cedis, tipo_venta, cedis_origen,
         almacen_central, division_en_operacion, unidad;
