-- =============================================================================
-- GOLD v2 · Comisión DBC — agregado diario. Fuente: dbc_comisiones_calculadas_cobro
-- (v1_comision_dbc_completo_cobro.sql). Tabla que lee comisiones_engine.py.
--
-- 2026-09-07: `comision_cobrada` sigue igual en estructura (comisión devengada
-- sobre facturado en `comision_total`, sobre cobrado en `comision_cobrada`),
-- pero su fuente de cobro cambió de sap_pago (~17%) a sap_bsad_cleared_items
-- (~87%). No requiere cambios en comisiones_engine.py.
--
-- base_unidad confirmado 2026-09-07 con distribución real de `sales_unit`
-- (monto DBC 2026): H/IA en kg (net_weight); A 100% PZA -> pieza; L 100% PZA
-- -> pieza (no litro, pese al nombre comercial); BO 99.4% PAQ -> paquete.
-- tipo_venta_origen no se rastrea (tarifa directa por SET+canal).
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_comision_diaria_v2`
PARTITION BY fecha
CLUSTER BY division_code, cedis, comision_estado
AS
WITH cedis_resuelto AS (
  -- Mismos 3 escalones de dbc_comisiones_calculadas_cobro, solo para exponer
  -- el nombre del CEDIS (la fuente no lo trae).
  SELECT
    t.billing_document, t.item_number,
    COALESCE(dc.cedis, dal.cedis, dco.cedis) AS cedis
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` t
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc
         ON dc.almacen = t.almacen AND dc.oficina = t.oficina_ventas
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
         ON dc.cedis IS NULL AND dal.almacen = t.almacen
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
         ON dc.cedis IS NULL AND dal.cedis IS NULL AND dco.oficina = t.oficina_ventas
),

-- Comisionista por oficina + división, CRUZANDO POR ID (cambiado 2026-09-07).
-- `DBC_dim_comision_tarifa.persona_cod` es el LIFNR sin zero-padding ('1019' =
-- Florentino, cuyo LIFNR es '0000001019'), así que la asignación viene de un
-- código, no de comparar nombres escritos a mano.
--
-- POR QUÉ SE CAMBIÓ: antes esto resolvía comparando grafías de nombres entre
-- las hojas del cliente (cascada de tokens + EDIT_DISTANCE + una excepción
-- manual para "FLORENTINO GLEZ"), y perdía casi la mitad de las asignaciones.
-- Medido contra los 29 comisionistas con pago de comisión en BSAK: por nombre
-- resolvía 22 personas y 56 pares oficina-persona, por ID resuelve 29 y 104.
-- Los casos que arreglaba de más eran justo los que no cuadraban contra el
-- pago real (Agustín 4 oficinas en vez de 2, Genaro 3 en vez de 1, Elias Barba
-- 3 en vez de 1). Ver Datos/sql/v1_conciliacion_pago_comisionista_vs_cobro.sql.
comisionista_id AS (
  SELECT
    oficina,
    division,
    persona_cod,
    -- La grafía más larga, SOLO para mostrar: el cruce es por código.
    ARRAY_AGG(persona ORDER BY LENGTH(persona) DESC, persona LIMIT 1)[OFFSET(0)] AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa`
  WHERE NULLIF(TRIM(persona_cod), '') IS NOT NULL
    AND NULLIF(TRIM(oficina), '')     IS NOT NULL
  GROUP BY oficina, division, persona_cod
),
-- LA ASIGNACIÓN VA POR OFICINA, y solo baja a oficina+división donde hace
-- falta. Una persona cubre TODAS las divisiones de su oficina (los pagos de
-- BSAK lo confirman: el mismo LIFNR cobra huevo, vuala, croqueta y leche), y
-- la tabla de tarifas no enumera todas las divisiones de cada oficina -- si se
-- exigiera la llave oficina+división en todos los casos, las divisiones no
-- enumeradas se quedarían sin comisionista (medido: la comisión sin asignar
-- subía de $2,54M a $4,25M).
comisionista_oficina AS (
  -- Caso normal: la oficina tiene un solo código en todas sus divisiones.
  SELECT oficina, ANY_VALUE(persona) AS persona
  FROM comisionista_id
  GROUP BY oficina
  HAVING COUNT(DISTINCT persona_cod) = 1
),
-- Solo para las oficinas que DOS comisionistas comparten se baja a la
-- división. Quedan 2 combinaciones sin resolver de 333: las oficinas 0012 y
-- 0083 en HUEVO, que aparecen con Genaro (4040) y Agustín (14718) a la vez.
-- Esas se dejan SIN ASIGNAR en vez de repartirlas -- asignarlas a los dos
-- contaría esa comisión dos veces (medido: infla a Genaro un 70% contra su
-- pago real de BSAK). Falta que el negocio diga de quién son.
-- (Las otras 3 oficinas compartidas -- 0123, 0171, 0180 -- son OROL con dos
-- códigos de proveedor para la misma empresa, así que sí resuelven por
-- división.)
comisionista_oficina_division AS (
  SELECT oficina, division, ANY_VALUE(persona) AS persona
  FROM comisionista_id
  WHERE oficina NOT IN (SELECT oficina FROM comisionista_oficina)
  GROUP BY oficina, division
  HAVING COUNT(DISTINCT persona_cod) = 1
),

base AS (
  SELECT
    t.billing_date                                          AS fecha,
    t.division                                               AS division_code,
    ba.business_area_name                                    AS division,
    cr.cedis,
    t.oficina_ventas                                         AS oficina,
    COALESCE(co.persona, cod.persona)                        AS comisionista,
    t.tipo_venta,
    t.set_material                                           AS `set`,
    CASE t.division
      WHEN 'H'  THEN 'kg'
      WHEN 'IA' THEN 'kg'
      WHEN 'A'  THEN 'pieza'
      WHEN 'L'  THEN 'pieza'
      WHEN 'BO' THEN 'paquete'
    END AS base_unidad,
    t.cantidad AS cantidad_base,
    CASE t.status
      WHEN 'OK'         THEN 'calculada'
      WHEN 'SIN_SET'    THEN 'material sin SET'
      WHEN 'SIN_CEDIS'  THEN 'sin CEDIS/tipo de venta'
      WHEN 'SIN_TARIFA' THEN 'sin tarifa para esa llave'
    END AS comision_estado,
    CAST(t.importe_mxn AS FLOAT64)                           AS monto,
    t.comision_mxn                                           AS comision,
    t.comision_cobrada,
    t.monto_cobrado,
    IF(t.importe_mxn = 0, TRUE, FALSE)                       AS sin_importe
  FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` t
  LEFT JOIN cedis_resuelto cr
         ON cr.billing_document = t.billing_document AND cr.item_number = t.item_number
  LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba
         ON ba.business_area_code = t.division
  LEFT JOIN comisionista c
         ON c.oficina = t.oficina_ventas AND c.division = t.division
)
SELECT
  fecha, division_code, division, cedis, oficina, comisionista, tipo_venta, `set`,
  base_unidad, comision_estado,
  CAST(NULL AS STRING) AS tipo_venta_origen,
  COUNT(*)                    AS num_lineas,
  SUM(monto)                  AS monto_total,
  SUM(cantidad_base)          AS cantidad_base_total,
  SUM(comision)                AS comision_total,
  CAST(NULL AS FLOAT64)        AS comision_min_total,
  CAST(NULL AS FLOAT64)        AS comision_max_total,
  SUM(comision_cobrada)        AS comision_cobrada,
  SUM(monto_cobrado)           AS monto_cobrado,
  COUNTIF(sin_importe)         AS lineas_sin_importe
FROM base
GROUP BY fecha, division_code, division, cedis, oficina, comisionista, tipo_venta, `set`,
         base_unidad, comision_estado;
