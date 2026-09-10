-- =============================================================================
-- Conciliación por comisionista — detalle por producto, agregado por PERIODO
-- DE PAGO. Fuente: `DBC_gold_conciliacion_producto_diario` (un solo lugar para
-- la lógica de enriquecimiento -- ver ese archivo) + `DBC_dim_periodo_pago`
-- (fecha -> periodo, `v1_dim_periodo_pago.sql` -- ahí está el porqué de cada
-- corte, no se repite aquí).
--
-- YA NO LA LEE LA PANTALLA DE CONCILIACIÓN (2026-09-09): `conciliacion_engine.py`
-- pasó a leer diario+dim directo, filtrando por fecha exacta en vez de por
-- este periodo ya agregado, para que "Calculado" responda al filtro día por
-- día en vez de meter o quitar un periodo completo cuando el rango pedido lo
-- corta a la mitad. Esta tabla se deja viva (pedido de Silvana) por si el
-- cliente la necesita para algo fuera de esta app -- no confundir con que
-- siga siendo la fuente de verdad de la pantalla, ya no lo es.
--
-- `sociedad` agregada 2026-09-08: ver el comentario en el archivo diario.
--
-- PERIODO DE PAGO, no "semana" a secas -- BUG REAL corregido 2026-09-02:
-- `DATE_TRUNC(fecha, WEEK(SATURDAY))` da sábado-viernes (7 días) SIEMPRE, sin
-- importar el mes. El caso real de Florentino (proveedor 0000001019, oficina
-- 0011, abril 2026) probó que el periodo verdadero corta antes: su pago real
-- fue "25 AL 30 DE ABRIL" (SGTXT de BSAK) -- 6 días, porque abril termina en
-- jueves 30. Con la fórmula vieja, el Excel de esa semana le sumaba el 1 de
-- mayo (que no le tocaba) y salía con +31% de volumen de más. La regla que lo
-- corrige vive ahora en `v1_dim_periodo_pago.sql`, verificada contra este
-- mismo caso real.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_semanal`
PARTITION BY semana
CLUSTER BY division_code, comisionista
AS
SELECT
  p.periodo_inicio AS semana,
  ANY_VALUE(p.periodo_fin) AS periodo_fin,
  d.sociedad, d.division_code, d.division, d.cedis, d.oficina, d.comisionista_id, d.comisionista, d.tipo_venta,
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
JOIN `proan-quantrue.ZZ_PRUEBAS.DBC_dim_periodo_pago` p ON p.fecha = d.fecha
GROUP BY semana, d.sociedad, d.division_code, d.division, d.cedis, d.oficina, d.comisionista_id, d.comisionista,
         d.tipo_venta, d.matnr, d.descripcion, d.unidad_venta, d.unidad_tarifa;
