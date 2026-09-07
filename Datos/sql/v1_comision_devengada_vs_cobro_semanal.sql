-- =============================================================================
-- Comisiones DBC — comisión por semana: devengada (venta) vs. cobrada
-- =============================================================================
-- Pregunta: el pago semanal al comisionista (BSAK, "COMISION CROQUETA 07-13
-- FEBRERO") ¿se explica por lo vendido esa semana o por lo cobrado esa semana?
--
-- Medido con semanas maduras (ene-mar 2026), Florentino/IA/oficina 0011 contra
-- sus 7 pagos reales: por semana de cobro 11.4% de diferencia mediana, por
-- semana de venta 10.7%. SON INDISTINGUIBLES -- ~99% de las facturas se cobran
-- a los pocos días de venderse, así que las dos ventanas contienen casi las
-- mismas facturas. El hueco que queda (~10-11%) NO viene de esta distinción.
--
-- OJO AL RANGO DE FECHAS (consulta 3): BSAD está incompleta en los meses
-- recientes -- ene-jun cobra ~100%, julio cae a 25% y agosto a 48%. Cualquier
-- medición "sobre cobrado" en esos meses mide el hueco de la fuente, no el
-- cobro real. Usar solo semanas maduras.
--
-- SOLO LECTURA -- son SELECTs sueltos, no crean ni reemplazan nada.
-- =============================================================================

-- 1) LA COMPARACIÓN. Un periodo, las dos interpretaciones al lado. Cambia las
--    fechas por el periodo que dice la etiqueta del pago real en BSAK, y las
--    oficinas/división por las del comisionista que estés revisando.
SELECT
  ROUND(SUM(IF(fecha_cobro  BETWEEN '2026-02-07' AND '2026-02-13', comision_cobrada, 0)), 2) AS por_semana_de_cobro,
  ROUND(SUM(IF(billing_date BETWEEN '2026-02-07' AND '2026-02-13', comision_mxn,     0)), 2) AS por_semana_de_venta
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
WHERE division = 'IA'
  AND oficina_ventas IN ('0011');

-- 2) Lo mismo pero en serie, semana a semana (sáb-vie), sin tener que ir pago
--    por pago. `devengada` agrupa por fecha de venta; `cobrada` por fecha de
--    cobro -- por eso la misma fila no habla de las mismas facturas.
SELECT
  DATE_TRUNC(billing_date, WEEK(SATURDAY)) AS semana,
  ROUND(SUM(comision_mxn), 2)              AS devengada_por_semana_de_venta
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
WHERE division = 'IA' AND oficina_ventas IN ('0011')
  AND billing_date BETWEEN '2026-01-01' AND '2026-06-30'
GROUP BY semana
ORDER BY semana;

SELECT
  DATE_TRUNC(fecha_cobro, WEEK(SATURDAY)) AS semana,
  ROUND(SUM(comision_cobrada), 2)         AS cobrada_por_semana_de_cobro
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
WHERE division = 'IA' AND oficina_ventas IN ('0011')
  AND fecha_cobro BETWEEN '2026-01-01' AND '2026-06-30'
GROUP BY semana
ORDER BY semana;

-- 3) EL CONTROL DE SANIDAD, correr esto antes de creerle a cualquier medición
--    sobre cobro: % de la comisión devengada que tiene cobro registrado, por
--    mes de venta. Si el mes está por debajo de ~95%, no está maduro (o BSAD no
--    lo ha cargado) y no sirve para comparar.
SELECT
  DATE_TRUNC(billing_date, MONTH) AS mes_de_venta,
  COUNT(*)                        AS lineas,
  ROUND(100 * SAFE_DIVIDE(SUM(comision_cobrada), SUM(comision_mxn)), 1) AS pct_cobrado
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
GROUP BY mes_de_venta
ORDER BY mes_de_venta;

-- 4) Curva de cobro: de lo devengado en cada semana de venta, cuántos días
--    después del cierre (viernes) se cobró. En meses maduros ~99% cae en el
--    primer tramo; eso es lo que hace indistinguibles las dos medidas de (1).
WITH linea AS (
  SELECT *, DATE_TRUNC(billing_date, WEEK(SATURDAY)) AS semana_venta
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
)
SELECT
  CASE
    WHEN fecha_cobro IS NULL THEN 'sin cobrar aún'
    WHEN DATE_DIFF(fecha_cobro, DATE_ADD(semana_venta, INTERVAL 6 DAY), DAY) <= 7  THEN '0-7 días tras cerrar semana'
    WHEN DATE_DIFF(fecha_cobro, DATE_ADD(semana_venta, INTERVAL 6 DAY), DAY) <= 14 THEN '8-14 días'
    WHEN DATE_DIFF(fecha_cobro, DATE_ADD(semana_venta, INTERVAL 6 DAY), DAY) <= 21 THEN '15-21 días'
    WHEN DATE_DIFF(fecha_cobro, DATE_ADD(semana_venta, INTERVAL 6 DAY), DAY) <= 28 THEN '22-28 días'
    ELSE '29+ días'
  END AS retraso_cobro,
  ROUND(SUM(comision_mxn), 2) AS comision_devengada
FROM linea
WHERE semana_venta BETWEEN '2026-01-01' AND '2026-05-31'   -- solo maduro, ver (3)
GROUP BY retraso_cobro
ORDER BY comision_devengada DESC;
