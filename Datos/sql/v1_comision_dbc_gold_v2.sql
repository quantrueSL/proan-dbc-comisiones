-- =============================================================================
-- GOLD v2 · Comisión DBC — agregado diario. Fuente: dbc_comisiones_calculadas_cobro
-- (v1_comision_dbc_completo_cobro.sql). Tabla que lee comisiones_engine.py.
--
-- 2026-09-07: `comision_cobrada` sigue igual en estructura (comisión devengada
-- sobre facturado en `comision_total`, sobre cobrado en `comision_cobrada`),
-- pero su fuente de cobro cambió de sap_pago (~17%) a sap_bsad_cleared_items
-- (~87%). No requiere cambios en comisiones_engine.py.
--
-- 2026-09-08: entra la sociedad PAN en huevo (ver `alcance_pan` en
-- v1_comision_dbc_completo_cobro.sql para el criterio del filtro y su
-- validación). Columna nueva `sociedad`: DBC o PAN, para poder separarlas en
-- pantalla -- el total de comisión devengada pasa de $45,3 M a $107,6 M, así
-- que enseñarlas mezcladas sin distinguirlas sería confuso.
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

-- Comisionista por oficina. Fuente: `DBC_dim_comisionista` (cambiado 2026-09-08),
-- que trae la LLAVE REAL -- sociedad + división + centro + almacén + oficina --
-- en vez de deducirlo de `DBC_dim_comision_tarifa` por oficina sola, que era el
-- origen de la confusión: una tabla de tarifas usada para saber de quién es una
-- oficina, con una llave incompleta.
--
-- LA SOCIEDAD ES PARTE DE LA LLAVE (2026-09-08, al integrar PAN): la misma
-- oficina puede tener comisionista distinto según la sociedad -- Celaya 0012
-- es de Agustín en DBC y de Genaro en PAN. Por eso el cruce va contra
-- `t.bukrs` de la factura y no contra un valor fijo.
--
-- Con esta llave desaparece la ambigüedad sola: 406 filas, 0 combinaciones con
-- más de un comisionista. Por eso no hace falta ninguna excepción manual.
--
-- NOMBRE CANÓNICO POR ID (2026-09-10): `DBC_dim_comisionista.persona` es texto
-- suelto de cada hoja de Excel del cliente, y DBC y PAN escriben distinto el
-- nombre de la MISMA persona (persona_cod idéntico) -- ej. "AGUSTIN JAIMES
-- MENDOZA" en DBC vs "AGUSTIN JAIMES" en PAN. Agrupar por ese texto (como
-- hacían los filtros y `por_comisionista`) partía a la persona en dos filas.
-- `dm_vendors` (maestro de proveedores SAP) trae un `razon_social` único por
-- LIFNR -- verificado: cubre 31 de los 32 persona_cod de este dataset, y
-- donde el Excel de PAN colapsaba a dos personas reales en el mismo texto
-- ("RAUL SALDAÑA" para persona_cod 7395 Y 9401), `dm_vendors` las distingue
-- bien (LOZANO vs FRANCO). Fallback a `persona` del Excel para el único LIFNR
-- sin cobertura (55947, segundo código de OROL).
comisionista_src AS (
  SELECT
    c.sociedad, c.division, c.oficina,
    LPAD(TRIM(c.persona_cod), 10, '0')      AS comisionista_id,
    COALESCE(v.razon_social, c.persona)     AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comisionista` c
  LEFT JOIN (
    SELECT id_proveedor, ANY_VALUE(razon_social) AS razon_social
    FROM `proan-quantrue.D20_DIMENSION.dm_vendors`
    GROUP BY id_proveedor
  ) v ON v.id_proveedor = LPAD(TRIM(c.persona_cod), 10, '0')
  WHERE NULLIF(TRIM(c.oficina), '') IS NOT NULL
),
-- La asignación va POR SOCIEDAD + OFICINA -- una persona cubre todas las
-- divisiones de su oficina (los pagos de BSAK lo confirman: el mismo LIFNR
-- cobra huevo, vuala, croqueta y leche) -- y es lo que da más cobertura: por
-- oficina cruzan 222 de las 255 combinaciones que trae la facturación, contra
-- 198 por oficina+división y 136 exigiendo la llave completa.
-- `s.comisionista_id` va calificado en el HAVING a propósito: sin el
-- prefijo, BigQuery lo resuelve al alias de arriba (ANY_VALUE, un agregado) y
-- falla con "Aggregations of aggregations are not allowed".
comisionista_oficina AS (
  SELECT sociedad, oficina, ANY_VALUE(s.comisionista_id) AS comisionista_id, ANY_VALUE(s.persona) AS persona
  FROM comisionista_src s
  GROUP BY sociedad, oficina
  HAVING COUNT(DISTINCT s.comisionista_id) = 1
),
-- Solo baja a división donde la oficina sola no alcanza: son 3 casos, las
-- oficinas 0123/0171/0180 de OROL, que tiene dos códigos de proveedor para la
-- misma empresa (15490 en botana, 55947 en croqueta). Con la división, esas 6
-- combinaciones resuelven todas.
comisionista_oficina_division AS (
  SELECT c.sociedad, c.oficina, c.division,
         ANY_VALUE(c.comisionista_id) AS comisionista_id, ANY_VALUE(c.persona) AS persona
  FROM comisionista_src c
  WHERE NOT EXISTS (SELECT 1 FROM comisionista_oficina o
                    WHERE o.sociedad = c.sociedad AND o.oficina = c.oficina)
  GROUP BY c.sociedad, c.oficina, c.division
  HAVING COUNT(DISTINCT c.comisionista_id) = 1
),

base AS (
  SELECT
    t.billing_date                                          AS fecha,
    t.bukrs                                                  AS sociedad,
    t.division                                               AS division_code,
    ba.business_area_name                                    AS division,
    cr.cedis,
    t.oficina_ventas                                         AS oficina,
    -- Para el detalle detrás de "sin CEDIS/tipo de venta" (2026-09-08): esa
    -- llave es almacén+oficina, no división+oficina+SET+tipo de venta como la
    -- de tarifa, y sin almacén no se puede mostrar cuál falta.
    t.almacen,
    COALESCE(co.comisionista_id, cod.comisionista_id)         AS comisionista_id,
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
  LEFT JOIN comisionista_oficina co
         ON co.sociedad = t.bukrs AND co.oficina = t.oficina_ventas
  LEFT JOIN comisionista_oficina_division cod
         ON cod.sociedad = t.bukrs AND cod.oficina = t.oficina_ventas
        AND cod.division = t.division
)
SELECT
  fecha, sociedad, division_code, division, cedis, oficina, almacen, comisionista_id, comisionista, tipo_venta, `set`,
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
GROUP BY fecha, sociedad, division_code, division, cedis, oficina, almacen, comisionista_id, comisionista, tipo_venta, `set`,
         base_unidad, comision_estado;
