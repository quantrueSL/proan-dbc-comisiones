-- =============================================================================
-- Conciliación — pago real (BSAK) vs. comisión calculada, por periodo de pago
-- =============================================================================
-- Un renglón por sociedad × comisionista × división × periodo. Es la base
-- nueva del nivel 1 de la pantalla de conciliación: hasta ahora esa tabla
-- solo mostraba lo calculado (`DBC_gold_conciliacion_producto_semanal`); esta
-- añade lo que de verdad se le pagó, para comparar sin salir de la pantalla.
--
-- SIGUE POR TEXTO, A PROPÓSITO: el periodo y la división salen del SGTXT de
-- BSAK ("COMISION CROQUETA 07-13 FEBRERO"). Se investigó un campo estructural
-- (cuenta contable `HKONT`) y no sirve -- es la cuenta general de proveedores,
-- mezcla comisión con compras de materia prima. El texto es lo único que
-- distingue comisión del resto de lo que se le paga a un comisionista (en PAN
-- el porteo es el 44% de sus pagos totales).
--
-- DIVISA: revisado (2026-09-09) -- `DMBTR` ya viene en pesos sea cual sea la
-- divisa del documento (es "importe en moneda local" de SAP, no la moneda de
-- la línea). Confirmado con las únicas 3 líneas en USD del filtro: su
-- proporción DMBTR/WRBTR (~17.2-17.4) es un tipo de cambio real de esas
-- fechas, no un importe sin convertir. Sí hay un texto de comisión BANCARIA
-- por transferencia internacional ("Comision Transferencia - Envio ; En Usd
-- (Internacional)", 31 líneas, $22,800) que por casualidad contiene la
-- palabra COMISION -- pero no trae periodo reconocible, así que ya queda
-- fuera igual que cualquier otro texto sin fecha. No se cuela nada por esto.
--
-- POR QUÉ VA SOBRE FECHA DE VENTA (`comision_mxn`, devengada) Y NO SOBRE
-- FECHA DE COBRO: se probaron las dos. Sobre una muestra chica (6 semanas de
-- Florentino/IA) cobro salía 24% mejor, pero al medir las 5 divisiones y las
-- 2 sociedades completas (2026-09-08) fue al revés -- venta cuadra mejor en
-- BO/IA/L, y la diferencia entre las dos formas nunca fue grande (es
-- coherente con que ~99% se cobra a los pocos días de venderse: casi
-- siempre dan lo mismo). No hay un criterio claramente mejor con los datos
-- que tenemos -- PENDIENTE DE CONFIRMAR CON EL CLIENTE cuál usan de verdad.
-- Se deja venta por ser la que mejor cuadra hoy, no por estar más segura.
--
-- SOCIEDAD ES PARTE DE LA LLAVE (no solo DBC): el mismo comisionista puede
-- tener oficinas distintas en DBC y en PAN (ver `DBC_dim_comisionista`), así
-- que el puente comisionista->oficina también cruza por sociedad.
--
-- YA NO DEPENDE DE `sap_bsad_cleared_items`: al ir por fecha de venta, "lo
-- calculado" sale de `comision_mxn` (devengada, sobre facturado), no de
-- `comision_cobrada`. El rezago de esa fuente en meses recientes ya no
-- afecta a esta tabla -- si se vuelve a cambiar a fecha de cobro, ese
-- rezago vuelve a aplicar.
--
-- DOS FUENTES DE PAGO, NINGUNA CUBRE TODO SOLA (2026-09-09):
-- `proan_BSAK_20260708` es una foto fija hasta el 8 de julio de 2026 (ver
-- memoria de sesión bsak_snapshot_congelado). `RT_BSAK` es la que se sigue
-- actualizando en producción y hoy arranca el 1 de agosto de 2026. Entre el
-- 9 y el 31 de julio no hay dato en NINGUNA de las dos -- hueco real de la
-- fuente, no un bug de esta consulta.
--
-- PERIODOS QUE NO SON UNA SEMANA NORMAL EXISTEN DE VERDAD, no son un error de
-- parseo: hay un ajuste real el 28/02/2026, "COMISIONES DEL 12 AL 28 DE
-- FEBRERO DEL 2026" (17 días, 13 comisionistas, $1.07M), que SE SOLAPA con
-- los pagos semanales normales de ese mismo tramo. Al sumar por comisionista
-- en un rango que incluya ese ajuste, el lado "nuestro" cuenta esa venta dos
-- veces (una por la semana normal, otra por el ajuste) -- el lado "pagado"
-- no, porque son dos pagos reales distintos. No se corrige aquí: es un caso
-- aislado ($1.07M sobre el total del libro) y arreglarlo bien requeriría
-- saber a qué facturas concretas corresponde el ajuste, que el texto no dice.
--
-- MESES MAL ESCRITOS O SIN NOMBRAR (revisado y corregido 2026-09-09):
--   - Typos de letra confirmados en el texto real, no adivinados: "ABRL" por
--     ABRIL (PAN, 14 filas, $1.48M) y "JUNI" por JUNIO (DBC, 19 filas,
--     $473,914). Se agregan como alias exactos en el CASE de meses -- no un
--     match difuso, solo estas dos variantes vistas de verdad en los datos.
--   - Mes pegado al día sin espacio ("21-27MARZO", DBC, 49 filas, $57,981):
--     el regex de DBC exigía al menos un espacio antes del mes -- se relaja
--     a cero-o-más.
--   - Texto que NO nombra el mes ("COMISIONES DEL 01 AL 09 DEL 2026", PAN,
--     29 filas, $3.52M): se infiere del mes de BUDAT (fecha de pago) --
--     ASUNCIÓN, no algo que el texto diga (asume que se paga el mismo mes
--     calendario del periodo que cubre). Hoy solo la dispara este único lote
--     real (pagado 14-ene para el periodo 01-09, ver memoria de sesión) --
--     a confirmar si aparecen más casos y si la asunción se sostiene.
--   - Quedan sin poder recuperarse (no traen NINGUNA fecha en el texto):
--     "COMISION HUEVO/VUALA/LECHE" a secas, "SEMANA ENERO - FEBRERO" (sin
--     días), y un formato suelto con diagonales ("06/12 AL 20/02/26").
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_pago_semanal`
PARTITION BY periodo
CLUSTER BY division_code, comisionista
AS
WITH bsak_crudo AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.proan_BSAK_20260708`
  UNION ALL
  -- BUDAT > el corte del snapshot fijo, aunque hoy no haya solape real: así
  -- si algún día se reprocesa con una versión de RT_BSAK más amplia, no se
  -- duplica nada.
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR, GJAHR, BELNR, BUZEI
  FROM `proan-quantrue.D00_SANDBOX.RT_BSAK`
  WHERE BUDAT > '20260708'
),
-- 27 documentos de verdad duplicados en la extracción (mismo BUKRS+GJAHR+
-- BELNR+BUZEI -- la llave real de una línea contable en SAP, confirmado con
-- el mismo BELNR repetido). Medido 2026-09-09: concentrado en dos corridas
-- completas, no en comisionistas sueltos -- 2026-07-08 (26 comisionistas de
-- PAN, "COMISIONES DEL 01 AL 03 DE JULIO DEL 2026") y 2026-04-07 (3
-- comisionistas, "28 AL 31 DE MARZO"). Sin deduplicar, $1,786,993 de más en
-- pago_real. QUALIFY se queda con una sola copia por documento.
bsak AS (
  SELECT BUKRS, LIFNR, BUDAT, BLART, SGTXT, DMBTR
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
    DMBTR AS pagado
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
cod AS (
  SELECT sociedad, LPAD(TRIM(persona_cod), 10, '0') AS lifnr, oficina, division, persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comisionista`
  WHERE NULLIF(TRIM(persona_cod), '') IS NOT NULL AND NULLIF(TRIM(oficina), '') IS NOT NULL
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
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro` c
       ON c.bukrs           = p.sociedad
      AND c.oficina_ventas  = o.oficina
      AND c.division        = p.division
      AND c.billing_date BETWEEN p.desde AND p.hasta
GROUP BY p.sociedad, p.LIFNR, p.division, p.desde;
