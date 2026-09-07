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
-- EL CRUCE ES POR ID, NO POR NOMBRE: `DBC_dim_comision_tarifa.persona_cod` es
-- el LIFNR sin zero-padding ('1019' = Florentino, LIFNR '0000001019'), así que
-- une directo contra BSAK y no hace falta `dm_vendors` ni comparar nombres.
-- Medido el 2026-09-07 contra el puente por nombre que usa gold v2:
--   por ID     -> 29 de 29 comisionistas, 104 pares oficina-persona
--   por nombre -> 22 de 29 comisionistas,  56 pares
-- El puente por nombre pierde casi la mitad de las oficinas, y justo en los
-- casos problemáticos (Agustín 4 vs 2, Genaro 3 vs 1, Elias Barba 3 vs 1).
-- PENDIENTE: `v1_comision_dbc_gold_v2.sql` sigue resolviendo comisionista por
-- nombre -- debería pasar a `persona_cod` por lo mismo.
--
-- RESULTADO al 2026-09-07 (ene-jun 2026, 2,003 comparaciones, 28 comisionistas):
--   sesgo global -12.8% (real $34.4M, nuestro $30.0M), error absoluto 23.8%,
--   mediana |dif| 9.8%. El sesgo es CASI TODO DE HUEVO:
--     L +0.3%    BO -2.6%    IA -6.7%    H -30.0%
--   Sin H la conciliación cuadra bien. H tiene su explicación conocida: parte
--   de la comisión de huevo se paga por la sociedad PAN y nosotros solo
--   miramos DBC (sus líneas en BSAK dicen "COMISIONES DEL x AL y", sin
--   división, así que no se pueden repartir) -- sin verificar todavía.
--   Casos sueltos que no son de división: Genaro +69.8% y Agustín -35.7%
--   (mapeo de oficinas), Maria de la Luz con 2 comparaciones de $1,144 (ruido).
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
-- EL PUENTE, por ID: oficina <-> LIFNR. `persona` viaja solo para leerlo.
oficina_lifnr AS (
  SELECT
    LPAD(TRIM(persona_cod), 10, '0') AS lifnr,
    oficina,
    ANY_VALUE(persona) AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa`
  WHERE persona_cod IS NOT NULL AND TRIM(persona_cod) != '' AND oficina IS NOT NULL
  GROUP BY lifnr, oficina
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
JOIN oficina_lifnr o ON o.lifnr = p.LIFNR
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` c
       ON c.oficina_ventas = o.oficina
      AND c.division       = p.division
      AND c.fecha_cobro BETWEEN p.desde AND p.hasta
WHERE p.hasta  < '2026-07-01'   -- BSAD incompleta desde julio, ver encabezado
  AND p.desde >= '2026-01-01'   -- nuestra tabla de comisión arranca aquí
GROUP BY p.LIFNR, p.division, p.desde, p.hasta
ORDER BY comisionista, p.division, p.desde;
