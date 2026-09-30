-- =============================================================================
-- INCREMENTAL · DBC_gold_conciliacion_pago_semanal
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/D60_REPORTING/DBC_gold_conciliacion_pago_semanal.sql
-- -- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `periodo`. Mismo valor de
-- `ventana_desde` que en los otros seis archivos de esta rama: si una gold usa
-- ventana más corta que su silver, conserva filas que la silver ya no tiene.
--
-- ORDEN EN EL DAG: Despues de DBC_comisiones_calculadas_cobro.
--
-- LA VENTANA VA SOBRE `periodo`, no sobre una fecha de factura: esta tabla se
-- particiona por el periodo de pago al comisionista, que sale del texto de
-- BSAK. `p.desde` es esa columna antes de renombrarse en el SELECT final.
--
-- Este INSERT es POSICIONAL. El orden es:
--   sociedad, comisionista_id, comisionista, division_code, periodo, periodo_fin,
--   pago_real, comision_calculada, diferencia, diff_pct
-- y tiene que coincidir con el esquema que crea el gemelo. Si falla con
-- "Inserted row has wrong column count", la tabla tiene un esquema viejo: hay
-- que recrearla con la versión completa.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_semanal`
WHERE periodo >= ventana_desde;

INSERT INTO `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_semanal`
WITH bsak_crudo AS (
  -- Recarga completa hasta el 29-sep (ver cabecera del histórico).
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.proan_BSAK_20260929`
  UNION ALL
  -- Pagos posteriores a la recarga: todas las fotos diarias desde ese día.
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.RT_BSAK_*`
  WHERE _TABLE_SUFFIX >= '20260929' AND BUDAT > '20260929'
  UNION ALL
  -- La tabla viva, mismo corte.
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.RT_BSAK`
  WHERE BUDAT > '20260929'
),
-- Una copia por BUKRS+GJAHR+BELNR+BUZEI (la llave de una línea contable): la
-- recarga trae cada documento repetido y las fotos RT se solapan entre sí.
bsak AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, QSSHB
  FROM bsak_crudo
  QUALIFY ROW_NUMBER() OVER (PARTITION BY BUKRS, GJAHR, BELNR, BUZEI ORDER BY BUDAT) = 1
),
pago_real AS (
  -- BLART='RE' es el lado con el texto real; el otro lado (KZ) trae SGTXT vacío.
  --
  -- DBC y PAN escriben el periodo distinto, así que cada uno tiene su propio
  -- patrón, sin anclar al inicio del texto (más flexible a variaciones):
  --   DBC: "COMISION HUEVO 25-30 ABRIL"          -- rango con guion
  --   PAN: "COMISIONES DEL 01 AL 09 DE ENERO..."  -- rango con "AL", sin
  --        decir división (PAN solo opera huevo, confirmado con
  --        `proan_ZTSD_OV_COM_H_20260829`: su tarifa es 100% huevo).
  -- Medido 2026-09-08: el patrón de PAN captura 885 de 925 líneas 'COMISION'
  -- ($69,95M de $71,1M) -- lo que queda fuera son otros conceptos genuinos
  -- (colocación de producto, transferencia bancaria, "servicio de
  -- distribuidores"), no variantes del mismo formato.
  --
  -- El grupo capturado de mes exige 3+ letras (`{3,}`, no `+`): sin eso, un
  -- texto sin mes como "...DEL 2026" hace que el regex de PAN retroceda
  -- sobre "DEL?" y capture la "L" suelta como si fuera el mes -- con `{3,}`
  -- ese caso da NULL de verdad (todos los meses en español tienen 4+
  -- letras), y se puede distinguir "no hay mes" de "hay un mes real".
  SELECT
    BUKRS AS sociedad,
    LIFNR,
    CASE
      WHEN BUKRS = 'PAN' THEN 'H'
      ELSE CASE REGEXP_EXTRACT(UPPER(SGTXT), r'^COMISION(?:ES)?\s+([A-ZÑ]+)')
        WHEN 'HUEVO'    THEN 'H'
        WHEN 'VUALA'    THEN 'BO'
        WHEN 'CROQUETA' THEN 'IA'
        WHEN 'LECHE'    THEN 'L'
      END
    END AS division,
    CAST(CASE WHEN BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(SGTXT), r'(\d{1,2})\s*AL\s*\d{1,2}\s*DEL?\s*[A-ZÑ]+')
      ELSE REGEXP_EXTRACT(UPPER(SGTXT), r'(\d{1,2})\s*-\s*\d{1,2}\s*[A-ZÑ]+')
    END AS INT64) AS dia_ini,
    CAST(CASE WHEN BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*AL\s*(\d{1,2})\s*DEL?\s*[A-ZÑ]+')
      ELSE REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*-\s*(\d{1,2})\s*[A-ZÑ]+')
    END AS INT64) AS dia_fin,
    CASE WHEN BUKRS = 'PAN'
      THEN REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*AL\s*\d{1,2}\s*DEL?\s*([A-ZÑ]{3,})')
      ELSE REGEXP_EXTRACT(UPPER(SGTXT), r'\d{1,2}\s*-\s*\d{1,2}\s*([A-ZÑ]{3,})')
    END AS mes_txt,
    -- PAN casi siempre trae el año en el propio texto ("DEL 2026"); si algún
    -- día no lo trae, se usa el año del pago (BUDAT) como respaldo. DBC nunca
    -- se toca aquí (su texto no trae año) -- explícito por sociedad para no
    -- arriesgar el año por un 4-dígitos suelto que apareciera en su SGTXT.
    CASE WHEN BUKRS = 'PAN'
      THEN COALESCE(
        SAFE_CAST(REGEXP_EXTRACT(UPPER(SGTXT), r'(\d{4})') AS INT64),
        CAST(SUBSTR(BUDAT, 1, 4) AS INT64)
      )
      ELSE CAST(SUBSTR(BUDAT, 1, 4) AS INT64)
    END AS anio_pago,
    -- Respaldo para cuando el texto no nombra el mes -- ver `periodo` abajo.
    CAST(SUBSTR(BUDAT, 5, 2) AS INT64) AS mes_budat,
    -- Base antes de IVA/retenciones; si viene en 0, se deduce del neto (ver cabecera del histórico).
    IF(QSSHB <> 0, QSSHB, ROUND(DMBTR / 1.0533, 2)) AS pagado
  FROM bsak
  WHERE BUKRS IN ('DBC', 'PAN') AND BLART = 'RE' AND UPPER(SGTXT) LIKE '%COMISION%'
),
periodo AS (
  -- El año sale del BUDAT del pago; diciembre pagado en enero es del año
  -- anterior (se compara contra `mes_efectivo` ya resuelto, no contra el
  -- texto crudo, para que también aplique si algún día el mes inferido por
  -- BUDAT resulta ser diciembre).
  SELECT
    sociedad, LIFNR, division, pagado,
    DATE(IF(mes_efectivo = 12 AND anio_pago > 2025, anio_pago - 1, anio_pago),
      mes_efectivo, dia_ini) AS desde,
    DATE(IF(mes_efectivo = 12 AND anio_pago > 2025, anio_pago - 1, anio_pago),
      mes_efectivo, dia_fin) AS hasta
  FROM (
    SELECT
      *,
      COALESCE(
        CASE mes_txt
          WHEN 'ENERO' THEN 1 WHEN 'FEBRERO' THEN 2 WHEN 'MARZO' THEN 3
          WHEN 'ABRIL' THEN 4 WHEN 'MAYO' THEN 5 WHEN 'JUNIO' THEN 6
          WHEN 'JULIO' THEN 7 WHEN 'AGOSTO' THEN 8 WHEN 'SEPTIEMBRE' THEN 9
          WHEN 'OCTUBRE' THEN 10 WHEN 'NOVIEMBRE' THEN 11 WHEN 'DICIEMBRE' THEN 12
          -- Typos reales confirmados en el texto (2026-09-09) -- no se
          -- adivina cualquier variante, solo estas dos vistas de verdad:
          WHEN 'ABRL' THEN 4  -- PAN, "...DE ABRL DEL 2026" (14 filas, $1.48M)
          WHEN 'JUNI' THEN 6  -- DBC, "...SEMANA 01-05 JUNI" (19 filas, $473,914)
        END,
        -- El texto no nombra el mes pero sí trae el rango de días -- se
        -- infiere del mes de BUDAT. Ver el porqué y el caso real en la
        -- cabecera del archivo.
        IF(dia_ini IS NOT NULL AND dia_fin IS NOT NULL, mes_budat, NULL)
      ) AS mes_efectivo
    FROM pago_real
  )
  WHERE division IS NOT NULL AND dia_ini IS NOT NULL
    AND dia_fin IS NOT NULL AND mes_efectivo IS NOT NULL
),
-- Filas donde ni el mes ni su inferencia por BUDAT resuelven nada (texto sin
-- ninguna fecha reconocible, ver la cabecera) dan `desde`/`hasta` NULL -- se
-- excluyen aquí, no se adivina más allá de lo ya descrito arriba.
periodo_valido AS (
  SELECT * FROM periodo WHERE desde IS NOT NULL
),
-- Un renglón por sociedad × comisionista × división × periodo (suma
-- correcciones si las hay).
pago AS (
  SELECT sociedad, LIFNR, division, desde, hasta, SUM(pagado) AS pagado
  FROM periodo_valido
  GROUP BY sociedad, LIFNR, division, desde, hasta
),
-- EL PUENTE, por ID, sociedad Y DIVISIÓN (2026-09-09, corregido): BSAK ya
-- trae la división en el propio texto del pago (o hardcodeada 'H' para PAN),
-- así que se usa siempre para resolver la oficina -- antes se ignoraba
-- cuando una oficina tenía un solo comisionista sin importar la división
-- (comodín NULL), lo que dejaba pasar una división que `DBC_dim_comisionista`
-- nunca le asignó de verdad a esa oficina. Medido: exigir división siempre da
-- 406 combinaciones válidas de (sociedad, oficina, división), más finas que
-- las 176 del diseño anterior (170 comodín + 6 con división) -- no es que
-- sobre cobertura, es que antes una sola fila "vale para toda la oficina"
-- ahora se reparte explícita por división.
--
-- SIGUE EN DOS PASOS a propósito, no por la división: un mismo comisionista
-- cubre VARIAS oficinas dentro de la misma división -- es lo normal, no la
-- excepción (129 combinaciones sociedad+LIFNR+división con 2 a 5 oficinas
-- cada una, ej. Edgardo Trujillo cubre 5 oficinas en Huevo). El JOIN de
-- abajo hace fan-out a propósito por `o.lifnr = p.LIFNR`: suma la comisión de
-- TODAS las oficinas que ese comisionista cubre en esa división, no solo una.
-- Nombre canónico por `dm_vendors` (2026-09-10, ver `v1_comision_dbc_gold_v2.sql`
-- para el porqué y las cifras de cobertura): el LIFNR ya es la llave, esto solo
-- corrige el texto que se enseña, que hoy discrepa entre la hoja de DBC y la de
-- PAN para la misma persona.
cod AS (
  SELECT
    c.sociedad, LPAD(TRIM(c.persona_cod), 10, '0') AS lifnr, c.oficina, c.division,
    COALESCE(v.razon_social, c.persona) AS persona
  FROM `proan-quantrue.D20_DIMENSION.dm_DBC_comisionista` c
  LEFT JOIN (
    SELECT id_proveedor, ANY_VALUE(razon_social) AS razon_social
    FROM `proan-quantrue.D20_DIMENSION.dm_vendors`
    GROUP BY id_proveedor
  ) v ON v.id_proveedor = LPAD(TRIM(c.persona_cod), 10, '0')
  WHERE NULLIF(TRIM(c.persona_cod), '') IS NOT NULL AND NULLIF(TRIM(c.oficina), '') IS NOT NULL
),
-- `cod.lifnr` va calificado en el HAVING a propósito: sin el prefijo, BigQuery
-- resuelve `lifnr` al alias de abajo (ANY_VALUE) y falla por agregar un agregado.
-- Si dos códigos distintos comparten oficina+división (los 3 casos de OROL),
-- esa combinación queda fuera aquí -- ambigua, no se adivina cuál de los dos.
oficina_lifnr AS (
  SELECT sociedad, oficina, division, ANY_VALUE(cod.lifnr) AS lifnr, ANY_VALUE(persona) AS persona
  FROM cod GROUP BY sociedad, oficina, division HAVING COUNT(DISTINCT cod.lifnr) = 1
)
SELECT
  p.sociedad,
  p.LIFNR                                                  AS comisionista_id,
  ANY_VALUE(o.persona)                                     AS comisionista,
  p.division                                               AS division_code,
  p.desde                                                  AS periodo,
  ANY_VALUE(p.hasta)                                       AS periodo_fin,
  ANY_VALUE(p.pagado)                                      AS pago_real,
  ROUND(SUM(c.comision_mxn), 2)                            AS comision_calculada,
  ROUND(SUM(c.comision_mxn) - ANY_VALUE(p.pagado), 2)      AS diferencia,
  ROUND(100 * SAFE_DIVIDE(SUM(c.comision_mxn) - ANY_VALUE(p.pagado), ANY_VALUE(p.pagado)), 1) AS diff_pct
FROM pago p
JOIN oficina_lifnr o
  ON o.sociedad = p.sociedad AND o.lifnr = p.LIFNR AND o.division = p.division
LEFT JOIN `proan-quantrue.D50_AGGREGATE.DBC_comisiones_calculadas_cobro` c
       ON c.bukrs           = p.sociedad
      AND c.oficina_ventas  = o.oficina
      AND c.division        = p.division
      AND c.fecha_cobro BETWEEN p.desde AND p.hasta   -- fecha de cobro, ver cabecera del histórico
WHERE p.desde >= ventana_desde   -- <- alcance incremental
GROUP BY p.sociedad, p.LIFNR, p.division, p.desde;

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D60_REPORTING.DBC_gold_conciliacion_pago_semanal`
  WHERE periodo >= ventana_desde
) > 0 AS 'DBC_gold_conciliacion_pago_semanal: la ventana quedó vacía tras el refresco';
