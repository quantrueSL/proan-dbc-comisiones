-- =============================================================================
-- Conciliación por cortes — un renglón por documento de pago de comisión (BSAK)
-- =============================================================================
-- Base de la pestaña nueva de conciliación por cortes. A diferencia de
-- `DBC_gold_conciliacion_pago_semanal` (una fila por sociedad × comisionista ×
-- división × periodo, con el calculado ya unido), esta tabla NO calcula nada:
-- solo identifica cada pago por su documento. El calculado se suma después, en
-- el motor, sobre la ventana que haya decidido el usuario.
--
-- LLAVE: `doc_id` = BUKRS|GJAHR|BELNR del documento de factura de comisión
-- (BLART = 'RE'). Medido 2026-10-14 sobre 5,060 documentos: cada uno tiene 1
-- línea, 1 texto y 1 compensación, así que es 1 a 1 con un periodo. La
-- compensación (`augbl`) NO sirve de llave: una transferencia agrupa 2-3
-- facturas de periodos o divisiones distintos (196 de 4,862 compensaciones).
-- El texto (`texto`) ya NO es llave: solo propone la ventana por defecto
-- (`desde_texto`, `hasta_texto`); lo que el usuario ajuste en la pantalla se
-- guarda contra `doc_id`, así que sobrevive a cualquier cambio de redacción.
--
-- VENTANA POR DEFECTO: sale del texto con la misma lógica que
-- `DBC_gold_conciliacion_pago_semanal` (ver su cabecera para los patrones de
-- DBC y PAN, el mes inferido por BUDAT y los dos typos reconocidos). Dos
-- diferencias a propósito:
--   - Los documentos cuya ventana no se puede leer (texto sin fecha o sin
--     división reconocible, 59 de 5,060 ≈ $1.6M) NO se descartan: salen con
--     `ventana_valida = FALSE` para que la pantalla los muestre como "pago sin
--     ventana" y la persona fije inicio y fin.
--   - `SAFE.DATE` en vez de `DATE`: un día imposible ("31 ABRIL") deja la fila
--     con ventana inválida en lugar de tumbar toda la carga.
--
-- UN PAGO DE PANTALLA PUEDE SER VARIOS DOCUMENTOS: 39 combinaciones de
-- sociedad × comisionista × división × ventana traen 2 documentos (correcciones,
-- $1.1M). Aquí siguen siendo filas separadas; el motor los agrupa y usa el de
-- menor `doc_id` como identificador del pago.
--
-- PARTICIÓN POR `fecha_pago` (BUDAT de la transferencia KZ), no por la del
-- documento RE: un documento viejo que se compensa hoy entra a BSAK hoy, y la
-- ventana incremental de Airflow tiene que alcanzarlo.
--
-- FUENTE Y FILTROS: idénticos a `pago_semanal` (recarga BSAK 29-sep + fotos RT,
-- deduplicado por llave contable, solo facturas de comisión con KZ real en su
-- compensación; las canceladas contra YE/AB quedan fuera, ver esa cabecera).
-- MONTO: QSSHB (base antes de IVA/retenciones); si viene en 0 se deduce del neto
-- (DMBTR / 1.0533) y `pagado_estimado` queda en TRUE.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_documento`
PARTITION BY fecha_pago
CLUSTER BY sociedad, comisionista_id, division_code
AS
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
-- Una copia por llave contable (la recarga repite documentos y las fotos RT se solapan).
bsak AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, AUGBL, GJAHR, BELNR
  FROM bsak_crudo
  QUALIFY ROW_NUMBER() OVER (PARTITION BY BUKRS, GJAHR, BELNR, BUZEI ORDER BY BUDAT) = 1
),
-- Transferencias reales: fecha del primer KZ de cada compensación.
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
        WHEN 'ABRL' THEN 4  -- typo real, PAN
        WHEN 'JUNI' THEN 6  -- typo real, DBC
      END,
      -- Texto sin mes pero con rango de días: se infiere del mes del documento.
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
-- El orden de columnas es el contrato con el gemelo de Airflow (INSERT posicional).
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
FROM doc_ventana;
