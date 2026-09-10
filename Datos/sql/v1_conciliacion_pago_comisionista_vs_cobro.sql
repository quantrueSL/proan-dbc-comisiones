-- =============================================================================
-- Conciliación: pago real al comisionista (BSAK) vs. nuestra comisión cobrada
-- =============================================================================
-- Un renglón por comisionista × división × periodo. El periodo y la división
-- salen del texto libre del pago (SGTXT: "COMISION CROQUETA 07-13 FEBRERO").
-- Nuestro lado suma `comision_cobrada` agrupando por `fecha_cobro` dentro de
-- ese periodo -- medido así porque es lo que mejor predice el pago (24% menos
-- error absoluto que agrupar por fecha de venta, sobre 7 semanas maduras de
-- Florentino/IA).
--
-- EL CRUCE ES POR ID, NO POR NOMBRE: `DBC_dim_comisionista.persona_cod` es el
-- LIFNR sin zero-padding ('1019' = Florentino, LIFNR '0000001019'), así que
-- une directo contra BSAK y no hace falta `dm_vendors` ni comparar nombres.
-- Medido el 2026-09-07 contra el puente por nombre que usaba gold v2:
--   por ID     -> 29 de 29 comisionistas, 104 pares oficina-persona
--   por nombre -> 22 de 29 comisionistas,  56 pares
-- El puente por nombre perdía casi la mitad de las oficinas, y justo en los
-- casos problemáticos (Agustín 4 vs 2, Genaro 3 vs 1, Elias Barba 3 vs 1).
-- 2026-09-08: la fuente pasó de `DBC_dim_comision_tarifa` (tabla de tarifas,
-- llave incompleta) a `DBC_dim_comisionista`, que trae sociedad+división+
-- centro+almacén+oficina. `v1_comision_dbc_gold_v2.sql` y
-- `v1_conciliacion_factura_linea.sql` usan la misma fuente y el mismo filtro.
--
-- RESULTADO al 2026-09-07 (ene-jun 2026, 1,924 comparaciones, 26 comisionistas):
--   sesgo global -14.2% (real $33.5M, nuestro $28.8M), error absoluto 22.6%,
--   mediana |dif| 8.2%. El sesgo es CASI TODO DE HUEVO:
--     L -2.6%    BO -4.1%    IA -8.1%    H -31.9%
--   Sin H la conciliación cuadra razonable. H tiene una explicación candidata:
--   parte de la comisión de huevo se paga por la sociedad PAN y nosotros solo
--   miramos DBC (sus líneas en BSAK dicen "COMISIONES DEL x AL y", sin
--   división, así que no se pueden repartir) -- SIN VERIFICAR todavía.
--   Agustín queda -39.7% porque sus oficinas 0012/0083 en huevo son las 2
--   ambiguas y se dejan sin asignar; Genaro queda en +0.2% sobre lo poco que
--   le queda propio (antes daba +69.8% por el doble conteo de esas mismas dos).
--
-- El rango está acotado a propósito: BSAD está incompleta desde julio (julio
-- cobra 25%, agosto 48%), así que periodos posteriores no son comparables.
-- SOLO LECTURA -- es un SELECT suelto, no crea ni reemplaza nada.
-- =============================================================================
WITH pago_real AS (
  -- BLART='RE' es el lado con el texto real; el otro lado (KZ) trae SGTXT vacío.
  SELECT
    LIFNR,
    CASE REGEXP_EXTRACT(UPPER(SGTXT), r'^COMISION(?:ES)?\s+([A-ZÑ]+)')
      WHEN 'HUEVO'    THEN 'H'
      WHEN 'VUALA'    THEN 'BO'
      WHEN 'CROQUETA' THEN 'IA'
      WHEN 'LECHE'    THEN 'L'
    END AS division,
    CAST(REGEXP_EXTRACT(UPPER(SGTXT), r'(\d{1,2})\s*-\s*\d{1,2}\s+[A-ZÑ]+') AS INT64) AS dia_ini,
    CAST(REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*-\s*(\d{1,2})\s+[A-ZÑ]+') AS INT64) AS dia_fin,
    REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*-\s*\d{1,2}\s+([A-ZÑ]+)') AS mes_txt,
    CAST(SUBSTR(BUDAT, 1, 4) AS INT64) AS anio_pago,
    DMBTR AS pagado
  FROM `proan-quantrue.D00_SANDBOX.proan_BSAK_20260708`
  WHERE BUKRS = 'DBC' AND BLART = 'RE' AND UPPER(SGTXT) LIKE 'COMISION%'
),
periodo AS (
  -- El año sale del BUDAT del pago; diciembre pagado en enero es del año anterior.
  SELECT
    LIFNR, division, pagado,
    DATE(IF(mes_txt = 'DICIEMBRE' AND anio_pago > 2025, anio_pago - 1, anio_pago),
      CASE mes_txt
        WHEN 'ENERO' THEN 1 WHEN 'FEBRERO' THEN 2 WHEN 'MARZO' THEN 3
        WHEN 'ABRIL' THEN 4 WHEN 'MAYO' THEN 5 WHEN 'JUNIO' THEN 6
        WHEN 'JULIO' THEN 7 WHEN 'AGOSTO' THEN 8 WHEN 'SEPTIEMBRE' THEN 9
        WHEN 'OCTUBRE' THEN 10 WHEN 'NOVIEMBRE' THEN 11 WHEN 'DICIEMBRE' THEN 12
      END, dia_ini) AS desde,
    DATE(IF(mes_txt = 'DICIEMBRE' AND anio_pago > 2025, anio_pago - 1, anio_pago),
      CASE mes_txt
        WHEN 'ENERO' THEN 1 WHEN 'FEBRERO' THEN 2 WHEN 'MARZO' THEN 3
        WHEN 'ABRIL' THEN 4 WHEN 'MAYO' THEN 5 WHEN 'JUNIO' THEN 6
        WHEN 'JULIO' THEN 7 WHEN 'AGOSTO' THEN 8 WHEN 'SEPTIEMBRE' THEN 9
        WHEN 'OCTUBRE' THEN 10 WHEN 'NOVIEMBRE' THEN 11 WHEN 'DICIEMBRE' THEN 12
      END, dia_fin) AS hasta
  FROM pago_real
  WHERE division IS NOT NULL AND dia_ini IS NOT NULL
    AND dia_fin IS NOT NULL AND mes_txt IS NOT NULL
),
-- Un renglón por comisionista × división × periodo (suma correcciones si hay).
pago AS (
  SELECT LIFNR, division, desde, hasta, SUM(pagado) AS pagado, COUNT(*) AS lineas_bsak
  FROM periodo
  GROUP BY LIFNR, division, desde, hasta
),
-- EL PUENTE, por ID: oficina <-> LIFNR. Misma regla que v1_comision_dbc_gold_v2:
-- la oficina completa si tiene un solo código, y solo donde dos códigos la
-- comparten se baja a oficina+división (son 3 casos, las oficinas de OROL).
-- 2026-09-08: la fuente pasó a `DBC_dim_comisionista` con `sociedad='DBC'`.
-- Con eso el conflicto de Celaya (0012/0083, Agustín vs. Genaro) desaparece
-- solo: era la fila de PAN colándose por cruzar sin sociedad.
-- Nombre canónico por `dm_vendors` (2026-09-10, ver `v1_comision_dbc_gold_v2.sql`
-- para el porqué): el LIFNR ya identifica a la persona, esto solo corrige el
-- texto que se enseña (el Excel del cliente discrepa entre DBC y PAN).
cod AS (
  SELECT
    LPAD(TRIM(c.persona_cod), 10, '0') AS lifnr, c.oficina, c.division,
    COALESCE(v.razon_social, c.persona) AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comisionista` c
  LEFT JOIN (
    SELECT id_proveedor, ANY_VALUE(razon_social) AS razon_social
    FROM `proan-quantrue.D20_DIMENSION.dm_vendors`
    GROUP BY id_proveedor
  ) v ON v.id_proveedor = LPAD(TRIM(c.persona_cod), 10, '0')
  WHERE c.sociedad = 'DBC'
    AND NULLIF(TRIM(c.persona_cod), '') IS NOT NULL AND NULLIF(TRIM(c.oficina), '') IS NOT NULL
),
-- `cod.lifnr` va calificado en el HAVING a propósito: sin el prefijo, BigQuery
-- resuelve `lifnr` al alias de arriba (ANY_VALUE) y falla por agregar un agregado.
oficina_unica AS (
  SELECT oficina, ANY_VALUE(cod.lifnr) AS lifnr, ANY_VALUE(persona) AS persona
  FROM cod GROUP BY oficina HAVING COUNT(DISTINCT cod.lifnr) = 1
),
oficina_division AS (
  SELECT oficina, division, ANY_VALUE(cod.lifnr) AS lifnr, ANY_VALUE(persona) AS persona
  FROM cod
  WHERE oficina NOT IN (SELECT oficina FROM oficina_unica)
  GROUP BY oficina, division HAVING COUNT(DISTINCT cod.lifnr) = 1
),
-- division NULL = vale para todas las divisiones de esa oficina
oficina_lifnr AS (
  SELECT lifnr, oficina, CAST(NULL AS STRING) AS division, persona FROM oficina_unica
  UNION ALL
  SELECT lifnr, oficina, division, persona FROM oficina_division
)
SELECT
  ANY_VALUE(o.persona) AS comisionista,
  p.LIFNR,
  p.division,
  p.desde,
  p.hasta,
  ANY_VALUE(p.pagado)                                     AS pago_real,
  ROUND(SUM(c.comision_cobrada), 2)                       AS nuestro_cobro,
  ROUND(SUM(c.comision_cobrada) - ANY_VALUE(p.pagado), 2) AS diferencia,
  ROUND(100 * SAFE_DIVIDE(SUM(c.comision_cobrada) - ANY_VALUE(p.pagado), ANY_VALUE(p.pagado)), 1) AS diff_pct,
  COUNT(DISTINCT o.oficina)                               AS oficinas
FROM pago p
JOIN oficina_lifnr o
  ON o.lifnr = p.LIFNR
 AND (o.division IS NULL OR o.division = p.division)
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` c
       ON c.oficina_ventas = o.oficina
      AND c.division       = p.division
      AND c.fecha_cobro BETWEEN p.desde AND p.hasta
WHERE p.hasta  < '2026-07-01'   -- BSAD incompleta desde julio, ver encabezado
  AND p.desde >= '2026-01-01'   -- nuestra tabla de comisión arranca aquí
GROUP BY p.LIFNR, p.division, p.desde, p.hasta
ORDER BY comisionista, p.division, p.desde;
