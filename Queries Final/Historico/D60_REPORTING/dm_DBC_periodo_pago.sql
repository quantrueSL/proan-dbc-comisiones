-- =============================================================================
-- DIMENSIÓN · fecha -> periodo de pago al comisionista
-- =============================================================================
-- Una fila por fecha, con el periodo de pago al que pertenece. La consume
-- `conciliacion_engine.py` para agrupar por periodo sin duplicar la lógica de
-- corte, y también `v1_conciliacion_producto_semanal.sql`.
--
-- ERA UNA TABLA, AHORA ES UNA VISTA (decidido el 2026-09-24). Motivos:
--   - Es `SELECT DISTINCT fecha` más aritmética de fechas sobre
--     `DBC_gold_conciliacion_producto_diario`, que ya es pequeña. No hay nada
--     que precalcular.
--   - Como tabla había que acordarse de refrescarla DESPUÉS de esa gold, o se
--     quedaba sin los días nuevos. Como vista está siempre al día por
--     construcción y desaparece un paso entero del orden de ejecución: no
--     necesita gemelo en `../../Airflow/`.
--   - Perdió el `PARTITION BY fecha` que tenía como tabla; una vista no se
--     particiona. Da igual: lo que se lee son cientos de filas.
--
-- VIVE EN D60_REPORTING Y NO EN D20_DIMENSION pese a llamarse `dm_`: depende de
-- una tabla gold, no de un Excel ni de un maestro del grupo. Meterla en D20
-- crearía una dependencia de D20 hacia D60, al revés del flujo de las capas.
--
-- LA REGLA DE CORTE (supuesto de Silvana del 2026-09-02, PENDIENTE DE CONFIRMAR
-- CON EL CLIENTE — el caso real de Florentino que la motivó está en la cabecera
-- de `v1_conciliacion_producto_semanal.sql`):
--   - Periodo normal: sábado a viernes, 7 días.
--   - Si ese periodo cruza de mes, se corta: el mes que termina se queda con
--     sábado hasta su último día (puede ser de 1 a 7 días).
--   - Los días sueltos del mes nuevo (día 1 hasta el viernes que le tocaba a
--     esa semana) no abren su propio periodo corto: se suman al periodo
--     siguiente, que entonces empieza el día 1 (puede durar 8-13 días).
-- =============================================================================
CREATE OR REPLACE VIEW `proan-quantrue.D60_REPORTING.dm_DBC_periodo_pago` AS
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
  FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_producto_diario`
);
