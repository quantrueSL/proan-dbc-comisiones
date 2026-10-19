-- =============================================================================
-- INCREMENTAL · DBC_gold_conciliacion_pago_documento
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/D60_REPORTING/DBC_gold_conciliacion_pago_documento.sql
-- -- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `fecha_pago`. Mismo valor de
-- `ventana_desde` que en los otros archivos de esta rama.
--
-- ORDEN EN EL DAG: no depende de ninguna otra tabla del pipeline (solo lee
-- BSAK); puede correr en paralelo con las gold del paso 3.
--
-- LA VENTANA VA SOBRE `fecha_pago` (BUDAT del KZ), no sobre la fecha del
-- documento RE: una factura de comisión vieja que se compensa hoy entra a BSAK
-- hoy y tiene que alcanzarla la ventana.
--
-- Este INSERT es POSICIONAL. El orden es:
--   sociedad, doc_id, comisionista_id, division_code, desde_texto, hasta_texto,
--   ventana_valida, pagado, pagado_estimado, fecha_doc, fecha_pago, augbl, texto
-- y tiene que coincidir con el esquema que crea el gemelo. Si falla con
-- "Inserted row has wrong column count", la tabla tiene un esquema viejo: hay
-- que recrearla con la versión completa.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento`
WHERE fecha_pago >= ventana_desde;

INSERT INTO `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento`
WITH bsak_crudo AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, AUGBL, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.proan_BSAK_20260929`
  UNION ALL
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, AUGBL, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.RT_BSAK_*`
  WHERE _TABLE_SUFFIX >= '20260929' AND BUDAT > '20260929'
  UNION ALL
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, AUGBL, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.RT_BSAK`
  WHERE BUDAT > '20260929'
),
bsak AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, AUGBL, GJAHR, BELNR
  FROM bsak_crudo
  QUALIFY ROW_NUMBER() OVER (PARTITION BY BUKRS, GJAHR, BELNR, BUZEI ORDER BY BUDAT) = 1
),
pago_kz AS (
  SELECT BUKRS, LIFNR, AUGBL, MIN(BUDAT) AS budat_kz
  FROM bsak WHERE BLART = 'KZ' GROUP BY BUKRS, LIFNR, AUGBL
),
doc AS (
  SELECT
    b.BUKRS AS sociedad,
    CONCAT(b.BUKRS, '|', b.GJAHR, '|', b.BELNR) AS doc_id,
    b.LIFNR AS comisionista_id,
    b.AUGBL AS augbl,
    b.SGTXT AS texto,
    SAFE.PARSE_DATE('%Y%m%d', b.BUDAT) AS fecha_doc,
    SAFE.PARSE_DATE('%Y%m%d', k.budat_kz) AS fecha_pago,
    CASE
      -- Error de texto (cliente, 13-oct): "COMISION CROQUETA 14-20 FEBRERO" de Agustín y César es Huevo.
      WHEN b.BUKRS = 'DBC' AND b.GJAHR = '2026' AND b.BELNR IN ('5100002986', '5100002934') THEN 'H'
      WHEN b.BUKRS = 'PAN' THEN 'H'
      ELSE CASE REGEXP_EXTRACT(UPPER(b.SGTXT), r'^COMISION(?:ES)?\s+([A-ZÑ]+)')
        WHEN 'HUEVO'    THEN 'H'
        WHEN 'VUALA'    THEN 'BO'
        WHEN 'CROQUETA' THEN 'IA'
        WHEN 'LECHE'    THEN 'L'
      END
    END AS division_code,
    CAST(CASE WHEN b.BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(b.SGTXT), r'(\d{1,2})\s*AL\s*\d{1,2}\s*DEL?\s*[A-ZÑ]+')
      ELSE REGEXP_EXTRACT(UPPER(b.SGTXT), r'(\d{1,2})\s*-\s*\d{1,2}\s*[A-ZÑ]+')
    END AS INT64) AS dia_ini,
    CAST(CASE WHEN b.BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(b.SGTXT), r'\d{1,2}\s*AL\s*(\d{1,2})\s*DEL?\s*[A-ZÑ]+')
      ELSE REGEXP_EXTRACT(UPPER(b.SGTXT), r'\d{1,2}\s*-\s*(\d{1,2})\s*[A-ZÑ]+')
    END AS INT64) AS dia_fin,
    CASE WHEN b.BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(b.SGTXT), r'\d{1,2}\s*AL\s*\d{1,2}\s*DEL?\s*([A-ZÑ]{3,})')
      ELSE REGEXP_EXTRACT(UPPER(b.SGTXT), r'\d{1,2}\s*-\s*\d{1,2}\s*([A-ZÑ]{3,})')
    END AS mes_txt,
    CASE WHEN b.BUKRS = 'PAN'
      THEN COALESCE(SAFE_CAST(REGEXP_EXTRACT(UPPER(b.SGTXT), r'(\d{4})') AS INT64), CAST(SUBSTR(b.BUDAT, 1, 4) AS INT64))
      ELSE CAST(SUBSTR(b.BUDAT, 1, 4) AS INT64)
    END AS anio_pago,
    CAST(SUBSTR(b.BUDAT, 5, 2) AS INT64) AS mes_budat,
    CAST(IF(b.QSSHB <> 0, b.QSSHB, ROUND(b.DMBTR / 1.0533, 2)) AS NUMERIC) AS pagado,
    b.QSSHB = 0 AS pagado_estimado
  FROM bsak b
  JOIN pago_kz k ON k.BUKRS = b.BUKRS AND k.LIFNR = b.LIFNR AND k.AUGBL = b.AUGBL
  WHERE b.BUKRS IN ('DBC', 'PAN') AND b.BLART = 'RE' AND UPPER(b.SGTXT) LIKE '%COMISION%'
),
doc_mes AS (
  SELECT *,
    COALESCE(
      CASE mes_txt
        WHEN 'ENERO' THEN 1 WHEN 'FEBRERO' THEN 2 WHEN 'MARZO' THEN 3
        WHEN 'ABRIL' THEN 4 WHEN 'MAYO' THEN 5 WHEN 'JUNIO' THEN 6
        WHEN 'JULIO' THEN 7 WHEN 'AGOSTO' THEN 8 WHEN 'SEPTIEMBRE' THEN 9
        WHEN 'OCTUBRE' THEN 10 WHEN 'NOVIEMBRE' THEN 11 WHEN 'DICIEMBRE' THEN 12
        WHEN 'ABRL' THEN 4
        WHEN 'JUNI' THEN 6
      END,
      IF(dia_ini IS NOT NULL AND dia_fin IS NOT NULL, mes_budat, NULL)
    ) AS mes_efectivo
  FROM doc
),
doc_ventana AS (
  SELECT *,
    SAFE.DATE(IF(mes_efectivo = 12 AND anio_pago > 2025, anio_pago - 1, anio_pago), mes_efectivo, dia_ini) AS desde_texto,
    SAFE.DATE(IF(mes_efectivo = 12 AND anio_pago > 2025, anio_pago - 1, anio_pago), mes_efectivo, dia_fin) AS hasta_texto
  FROM doc_mes
)
SELECT
  sociedad,
  doc_id,
  comisionista_id,
  division_code,
  desde_texto,
  hasta_texto,
  (division_code IS NOT NULL AND desde_texto IS NOT NULL AND hasta_texto IS NOT NULL
   AND desde_texto <= hasta_texto) AS ventana_valida,
  pagado,
  pagado_estimado,
  fecha_doc,
  fecha_pago,
  augbl,
  texto
FROM doc_ventana
WHERE fecha_pago >= ventana_desde;   -- <- alcance incremental

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento`
  WHERE fecha_pago >= ventana_desde
) > 0 AS 'DBC_gold_conciliacion_pago_documento: la ventana quedó vacía tras el refresco';
