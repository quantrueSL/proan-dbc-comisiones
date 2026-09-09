-- =============================================================================
-- Dimensión fecha -> periodo de pago. Antes vivía como CTE metida dentro de
-- `v1_conciliacion_producto_semanal.sql`; se separa aquí (2026-09-09) para que
-- `conciliacion_engine.py` pueda agrupar por el mismo periodo sin duplicar la
-- lógica de corte -- el nivel 1 y 2 de la pantalla de Conciliación pasaron a
-- leer la tabla diaria filtrada por fecha exacta (para que "Calculado"
-- responda al filtro día por día, no periodo completo) pero agrupada por este
-- mismo periodo para mostrarse igual que siempre. `v1_conciliacion_producto_semanal.sql`
-- también pasa a leer de aquí en vez de calcularlo por su cuenta.
--
-- MISMA REGLA, SIN CAMBIOS (supuesto de Silvana, 2026-09-02, PENDIENTE DE
-- CONFIRMAR CON EL CLIENTE -- el caso real de Florentino que la motivó está
-- en la cabecera de `v1_conciliacion_producto_semanal.sql`):
--   - Periodo normal: sábado a viernes, 7 días.
--   - Si ese periodo cruza de mes, se corta: el mes que termina se queda con
--     sábado hasta su último día (puede ser de 1 a 7 días).
--   - Los días sueltos del mes nuevo (día 1 hasta el viernes que le tocaba a
--     esa semana) no abren su propio periodo corto: se suman al periodo
--     siguiente, que entonces empieza el día 1 (puede durar 8-13 días).
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_dim_periodo_pago`
PARTITION BY fecha
AS
SELECT
  fecha,
  CASE
    WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
         AND fecha <= LAST_DAY(semana_natural)
      THEN semana_natural
    WHEN DATE_TRUNC(semana_natural, MONTH) != DATE_TRUNC(fin_natural, MONTH)
      THEN DATE_TRUNC(fin_natural, MONTH)
    WHEN DATE_TRUNC(DATE_SUB(semana_natural, INTERVAL 7 DAY), MONTH)
         != DATE_TRUNC(DATE_SUB(semana_natural, INTERVAL 1 DAY), MONTH)
      THEN DATE_TRUNC(semana_natural, MONTH)
    ELSE semana_natural
  END AS periodo_inicio,
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
);
