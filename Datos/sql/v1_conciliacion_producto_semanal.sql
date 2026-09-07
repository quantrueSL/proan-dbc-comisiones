-- =============================================================================
-- Conciliación por comisionista — detalle por producto, agregado por PERIODO
-- DE PAGO. Fuente: `DBC_gold_conciliacion_producto_diario` (un solo lugar para
-- la lógica de enriquecimiento -- ver ese archivo).
--
-- PERIODO DE PAGO, no "semana" a secas -- BUG REAL corregido 2026-09-02:
-- `DATE_TRUNC(fecha, WEEK(SATURDAY))` da sábado-viernes (7 días) SIEMPRE, sin
-- importar el mes. El caso real de Florentino (proveedor 0000001019, oficina
-- 0011, abril 2026) probó que el periodo verdadero corta antes: su pago real
-- fue "25 AL 30 DE ABRIL" (SGTXT de BSAK) -- 6 días, porque abril termina en
-- jueves 30. Con la fórmula vieja, el Excel de esa semana le sumaba el 1 de
-- mayo (que no le tocaba) y salía con +31% de volumen de más.
--
-- REGLA (supuesto de Silvana, 2026-09-02, PENDIENTE DE CONFIRMAR CON EL
-- CLIENTE -- no es un hecho verificado, es la mejor hipótesis hasta que se
-- confirme):
--   - Periodo normal: sábado a viernes, 7 días, igual que antes.
--   - Si ese periodo cruza de mes, se corta: el mes que termina se queda con
--     sábado hasta su último día (puede ser de 1 a 7 días).
--   - Los días sueltos que quedan al inicio del mes nuevo (del día 1 hasta el
--     viernes que le tocaba a esa semana) NO abren su propio periodo corto:
--     se suman al periodo siguiente, que entonces empieza el día 1 en vez de
--     su sábado normal (y por eso puede durar 8-13 días en vez de 7).
--
-- Verificado contra el caso real: la fórmula de abajo da exacto "25 abril" a
-- "30 abril" en un periodo y "1 mayo" a "8 mayo" en el siguiente -- reproduce
-- el SGTXT real de BSAK.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_semanal`
PARTITION BY semana
CLUSTER BY division_code, comisionista
AS
WITH periodo_pago AS (
  SELECT
    fecha,
    CASE
      -- Esta semana natural cruza de mes, y esta fecha cae en el mes que cierra.
      WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
           AND fecha <= LAST_DAY(semana_natural)
        THEN semana_natural
      -- Esta semana natural cruza de mes, y esta fecha ya es del mes nuevo.
      WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
        THEN DATE_TRUNC(fin_natural, MONTH)
      -- Esta semana no cruza, pero la ANTERIOR sí -- esta absorbe sus días sueltos.
      WHEN DATE_TRUNC(DATE_SUB(semana_natural, INTERVAL 7 DAY), MONTH)
           != DATE_TRUNC(DATE_SUB(semana_natural, INTERVAL 1 DAY), MONTH)
        THEN DATE_TRUNC(semana_natural, MONTH)
      -- Semana normal, sin cruce en ningún lado.
      ELSE semana_natural
    END AS periodo_inicio,
    -- Espejo exacto del CASE de arriba, para el otro extremo del rango -- se
    -- pidió mostrar "inicio - fin" en vez de solo el inicio (parecía un solo
    -- día). Probado que es constante dentro de cada grupo de periodo_inicio:
    -- ej. 25-30 abril y 1-8 mayo dan aquí 30 abril y 8 mayo respectivamente
    -- para TODAS sus fechas, así que agregar con ANY_VALUE es seguro.
    CASE
      WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
           AND fecha <= LAST_DAY(semana_natural)
        THEN LAST_DAY(semana_natural)
      WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
        THEN DATE_ADD(semana_natural, INTERVAL 13 DAY)
      ELSE fin_natural
    END AS periodo_fin
  FROM (
    SELECT DISTINCT
      fecha,
      DATE_TRUNC(fecha, WEEK(SATURDAY)) AS semana_natural,
      DATE_ADD(DATE_TRUNC(fecha, WEEK(SATURDAY)), INTERVAL 6 DAY) AS fin_natural
    FROM `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`
  )
)
SELECT
  pp.periodo_inicio AS semana,
  ANY_VALUE(pp.periodo_fin) AS periodo_fin,
  d.division_code, d.division, d.cedis, d.oficina, d.comisionista, d.tipo_venta,
  d.matnr, d.descripcion, d.unidad_venta, d.unidad_tarifa,
  -- Una sola tarifa por grupo: ya viene fija por división+oficina+SET+canal.
  -- Verificado 2026-09-02 (MIN vs MAX antes de colapsar): 0 grupos con más de
  -- un valor -- si algún día eso deja de ser cierto, se nota porque el total
  -- de comisión deja de cuadrar contra `DBC_gold_comision_diaria_v2`, no aquí.
  ANY_VALUE(d.tarifa)            AS tarifa,
  SUM(d.num_lineas)              AS num_lineas,
  SUM(d.cantidad_venta_total)    AS cantidad_venta_total,
  SUM(d.monto_total)             AS monto_total,
  SUM(d.cantidad_base_total)     AS cantidad_base_total,
  SUM(d.comision_total)          AS comision_total,
  SUM(d.lineas_sin_comision)     AS lineas_sin_comision
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario` d
JOIN periodo_pago pp ON pp.fecha = d.fecha
GROUP BY semana, d.division_code, d.division, d.cedis, d.oficina, d.comisionista,
         d.tipo_venta, d.matnr, d.descripcion, d.unidad_venta, d.unidad_tarifa;
