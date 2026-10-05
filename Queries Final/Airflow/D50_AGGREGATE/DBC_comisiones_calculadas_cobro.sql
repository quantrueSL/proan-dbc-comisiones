-- =============================================================================
-- INCREMENTAL · DBC_comisiones_calculadas_cobro
-- -----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/D50_AGGREGATE/DBC_comisiones_calculadas_cobro.sql
-- -- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de `billing_date`. Mismo valor de
-- `ventana_desde` que en los otros seis archivos de esta rama: si una gold usa
-- ventana más corta que su silver, conserva filas que la silver ya no tiene.
--
-- ORDEN EN EL DAG: Primera de la cadena, junto con DBC_silver_flujo_producto. Necesita que
-- scripts/tablas_cliente.py --cargar haya corrido antes (dimensiones de D20).
--
-- `factura_totales` NO lleva ventana a proposito: es el denominador del
-- prorrateo del cobro y se cruza por `billing_document`, no por fecha. Si se
-- le recortara la fecha, una factura de la ventana cuyo total incluye lineas
-- fuera de ella prorratearia mal.
--
-- Este INSERT es POSICIONAL. El orden es:
--   billing_document, item_number, billing_date, bukrs, division, oficina_ventas,
--   almacen, planta, cedis, cedis_origen, matnr, set_material, tipo_venta, canal,
--   cantidad, importe_mxn, tarifa, status, comision_mxn, se_cobro, monto_cobrado,
--   cantidad_cobrada, comision_cobrada, fecha_cobro
-- y tiene que coincidir con el esquema que crea el gemelo. Si falla con
-- "Inserted row has wrong column count", la tabla tiene un esquema viejo: hay
-- que recrearla con la versión completa.
-- =============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.D50_AGGREGATE.DBC_comisiones_calculadas_cobro`
WHERE billing_date >= ventana_desde;

INSERT INTO `proan-quantrue.D50_AGGREGATE.DBC_comisiones_calculadas_cobro`

WITH

sets AS (
  SELECT
    LTRIM(CAST(MATNR AS STRING), '0') AS matnr_clean,
    ANY_VALUE(SETNAME) AS SETNAME
  FROM `proan-quantrue.D00_SANDBOX.sap_setleaf_comisiones`
  GROUP BY matnr_clean
),

-- ==========================================================================
-- 2026-09-24: CEDIS SE RESUELVE AQUÍ, en la silver, y viaja como columna.
-- Antes cada consumidor repetía la cascada por su cuenta y se descuadraban:
-- `v1_conciliacion_factura_linea.sql` la hacía con 3 de los 4 escalones (le
-- faltaba el de nombre) y por eso dejaba 1.275 líneas / $9.613.778 sin CEDIS
-- que el flujo de producto sí resolvía. Resolviéndolo una sola vez aquí, ese
-- archivo pasa a leer la columna y el descuadre no puede volver a aparecer.
--
-- Los cuatro escalones de abajo son copia literal de las vistas dim_cedis_v1 /
-- _almacen_v1 / _nombre_v1 / _oficina_v1 (`v1_flujo_producto_dbc.sql`, secciones
-- 1, 1b, 1c y 1d), traídos inline para que esas cuatro vistas se puedan retirar
-- cuando los tres consumidores dejen de usarlas.
--
-- Verificado contra la tabla viva antes de sustituirla (tabla _test, 2026-09-24):
-- cero llaves duplicadas, las 18 columnas no-cobro idénticas fila por fila (las
-- 4 de cobro se mueven solas porque BSAD cambia a diario), 1.275 líneas y
-- $9.613.778 de ganancia exactos contra lo predicho, y cero retrocesos:
-- ninguna línea pierde un CEDIS que antes tenía.
-- ==========================================================================
-- DESEMPATE DE LAS LLAVES AMBIGUAS DE dm_cedis (2026-09-24).
-- `dm_cedis` da DOS cedis distintos para la misma llave almacén+oficina en
-- exactamente 2 casos, y los dos son el mismo sitio: BO11/0122 y H717/0122,
-- "Celaya Agustin" contra "Celaya Genaro". El `ROW_NUMBER ... ORDER BY sector`
-- de abajo no los separa (ambas filas comparten sector), así que ganaba una
-- arbitrariamente -- y salía Agustin en TODO, incluidas las líneas cuyo
-- comisionista es Genaro.
--
-- Esos nombres de CEDIS son nombres de comisionista, así que se desempata con
-- la llave que ya está validada: la asignación de `DBC_dim_comisionista`, que
-- se cruza por LIFNR y se contrastó contra el pago real de BSAK (ver
-- v1_comision_dbc_gold_v2.sql). Las 5 filas de la oficina 0122 en esa tabla
-- dicen GENARO QUIROZ PEREZ (4040) -- DBC y PAN, divisiones H/BO/IA/L --, y
-- ninguna dice Agustin. Las listas de almacén-oficina del cliente coinciden
-- ("CELAYA (Genaro)" en A, H y L).
--
-- Es autolimitado por construcción: solo mira llaves con más de un cedis, y
-- solo decide si queda UNA candidata tras cruzar con el comisionista. Si
-- mañana `dm_cedis` deja de ser ambigua, este CTE no hace nada.
-- Lo correcto de verdad sería corregir `dm_cedis`, que es maestro del grupo y
-- no es nuestro -- esto es el parche del lado del consumidor mientras tanto.
cedis_desempate_comisionista AS (
  SELECT almacen, oficina, MIN(cedis) AS cedis
  FROM (
    SELECT DISTINCT k.almacen, k.oficina, k.cedis
    FROM (
      SELECT DISTINCT c.almacen, c.oficina, c.cedis
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis` c
      WHERE (c.almacen, c.oficina) IN (
        SELECT (almacen, oficina) FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
        GROUP BY almacen, oficina HAVING COUNT(DISTINCT cedis) > 1)
    ) k
    JOIN (
      SELECT DISTINCT oficina, persona
      FROM `proan-quantrue.D20_DIMENSION.dm_DBC_comisionista`
      WHERE persona IS NOT NULL AND persona != ''
    ) p ON p.oficina = k.oficina
    -- el nombre del CEDIS contiene un nombre/apellido del comisionista
    WHERE EXISTS (
      SELECT 1
      FROM UNNEST(SPLIT(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(p.persona, NFKD), r'[^a-z ]', ''), ' ')) tok
      WHERE LENGTH(tok) >= 4
        AND STRPOS(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(k.cedis, NFKD), r'[^a-z ]', ''), tok) > 0
    )
  )
  GROUP BY almacen, oficina
  HAVING COUNT(*) = 1
),

esc_1_almacen_oficina AS (
  SELECT * EXCEPT (rn)
  FROM (
    SELECT c.almacen, c.oficina, c.cedis, c.sector, c.tipo_venta,
           ROW_NUMBER() OVER (PARTITION BY c.almacen, c.oficina ORDER BY c.sector) AS rn
    FROM `proan-quantrue.D20_DIMENSION.dm_cedis` c
    LEFT JOIN cedis_desempate_comisionista d
           ON d.almacen = c.almacen AND d.oficina = c.oficina
    -- donde el comisionista resolvió la ambigüedad, solo compiten las filas de
    -- ESE cedis -- así `tipo_venta` también sale de la fila correcta, no de la
    -- del otro comisionista.
    WHERE d.cedis IS NULL OR c.cedis = d.cedis
  )
  WHERE rn = 1
),

esc_2_almacen AS (
  SELECT almacen, ANY_VALUE(cedis) AS cedis
  FROM (
    SELECT almacen, cedis
    FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
    GROUP BY almacen, cedis
  )
  GROUP BY almacen
  HAVING COUNT(*) = 1
),

esc_3_nombre AS (
  SELECT * EXCEPT (rn)
  FROM (
    SELECT
      IFNULL(l.planta, '') AS planta,
      l.almacen,
      COALESCE(c.cedis, l.nombre_cedis) AS cedis,
      ROW_NUMBER() OVER (
        PARTITION BY l.almacen
        ORDER BY IF(l.origen = 'deducido', 0, 1), l.planta DESC, l.nombre_cedis
      ) AS rn
    FROM (
      SELECT planta, almacen, nombre_cedis, origen,
             UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(nombre_cedis, NFKD), r'[^a-z0-9]', '')) AS clave
      FROM `proan-quantrue.D20_DIMENSION.dm_DBC_almacen_nombre`
      WHERE nombre_cedis IS NOT NULL AND nombre_cedis != ''
    ) l
    LEFT JOIN (
      SELECT DISTINCT cedis,
             UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(cedis, NFKD), r'[^a-z0-9]', '')) AS clave
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
    ) c ON c.clave = l.clave
  )
  WHERE rn = 1
),

esc_4_oficina AS (
  SELECT * EXCEPT (filas, rn)
  FROM (
    SELECT oficina, cedis, tipo_venta, COUNT(*) AS filas,
           ROW_NUMBER() OVER (
             PARTITION BY oficina ORDER BY COUNT(*) DESC, cedis, tipo_venta
           ) AS rn
    FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
    WHERE oficina IN (
      SELECT oficina
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
      GROUP BY oficina
      HAVING COUNT(DISTINCT almacen) > 1
    )
    GROUP BY oficina, cedis, tipo_venta
  )
  WHERE rn = 1
),

-- Una fila por almacén+oficina+planta: cada escalón está deduplicado por su
-- propia llave, así que este JOIN no puede multiplicar filas de facturación.
cedis_asignado AS (
  SELECT
    k.almacen, k.oficina, k.planta,
    COALESCE(e1.cedis, e2.cedis, e3.cedis, e4.cedis) AS cedis,
    CASE WHEN e1.cedis IS NOT NULL THEN 'almacen+oficina'
         WHEN e2.cedis IS NOT NULL THEN 'solo almacen'
         WHEN e3.cedis IS NOT NULL THEN 'lista de nombres'
         WHEN e4.cedis IS NOT NULL THEN 'solo oficina'
    END AS cedis_origen
  FROM (
    SELECT DISTINCT
      storage_location AS almacen, sales_office AS oficina, receiving_plant AS planta
    FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
    WHERE company_code IN ('DBC','PAN')
  ) k
  LEFT JOIN esc_1_almacen_oficina e1
         ON e1.almacen = k.almacen AND e1.oficina = k.oficina
  LEFT JOIN esc_2_almacen e2
         ON e1.cedis IS NULL AND e2.almacen = k.almacen
  LEFT JOIN esc_3_nombre e3
         ON e1.cedis IS NULL AND e2.cedis IS NULL AND e3.almacen = k.almacen
        AND (e3.planta IS NULL OR e3.planta = '' OR e3.planta = k.planta)
  LEFT JOIN esc_4_oficina e4
         ON e1.cedis IS NULL AND e2.cedis IS NULL AND e3.cedis IS NULL
        AND e4.oficina = k.oficina
),

-- 2026-09-08: BUG CORREGIDO -- `dim_cedis_almacen_v1` no tiene columna
-- `tipo_venta` (solo resuelve nombre de CEDIS, que esta CTE ni siquiera
-- expone), pero su éxito bloqueaba el tercer intento (`dim_cedis_oficina_v1`)
-- igual que si hubiera resuelto tipo_venta. Confirmado con datos: 6 de las 23
-- combinaciones bloqueadas por "sin CEDIS/tipo de venta" tenían el tipo de
-- venta esperando en `dim_cedis_oficina_v1`, nunca consultado porque
-- `dim_cedis_almacen_v1` encontraba un CEDIS por otro lado. Se quita ese join
-- (no aporta nada a esta CTE) y el tercer intento ahora depende de si
-- `tipo_venta` sigue sin resolver, no de si el segundo intento encontró algo
-- que aquí ni se usa. ~$0,26 M que antes caían en "sin CEDIS/tipo de venta".
cedis AS (
  SELECT
    f.storage_location AS almacen,
    f.sales_office      AS oficina,
    COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
    CASE
      WHEN COALESCE(dc.tipo_venta, dco.tipo_venta) IN ('VTA EN RUTA','VTA EN PISO') THEN 'MENUDEO'
      WHEN COALESCE(dc.tipo_venta, dco.tipo_venta) IN ('MED MAYOREO','MAYOREO')     THEN 'MAYOREO'
      ELSE NULL
    END AS canal
  FROM (SELECT DISTINCT storage_location, sales_office
        FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
        -- PAN incluida (2026-09-08): sus almacenes necesitan resolver
        -- tipo_venta igual que los de DBC. Verificado que `dm_cedis` los cubre
        -- al 100%, así que no abre ningún hueco nuevo.
        WHERE company_code IN ('DBC','PAN')) f
  -- 2026-09-24: mismos dos escalones, pero inline (esc_1/esc_4 de arriba) en vez
  -- de las vistas dim_cedis_v1/dim_cedis_oficina_v1, para poder retirarlas. La
  -- lógica es idéntica: esas vistas son exactamente esas dos CTEs.
  LEFT JOIN esc_1_almacen_oficina dc
         ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
  LEFT JOIN esc_4_oficina dco
         ON dc.tipo_venta IS NULL AND dco.oficina = f.sales_office
),

tarifas_h AS (
  SELECT
    BUKRS, WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(HSANJUAN_PISO)      AS FLOAT64) AS HSANJUAN_MENUDEO,
    SAFE_CAST(TRIM(HSANJUAN_RUTA)      AS FLOAT64) AS HSANJUAN_RUTA,
    SAFE_CAST(TRIM(HSANJUAN_MMAY)      AS FLOAT64) AS HSANJUAN_MMAY,
    SAFE_CAST(TRIM(HSANJUAN_MAY)       AS FLOAT64) AS HSANJUAN_MAYOREO,
    SAFE_CAST(TRIM(HSANJUAN_ABASTOS)   AS FLOAT64) AS HSANJUAN_ABASTOS,
    SAFE_CAST(TRIM(HPORTALES_PISO)     AS FLOAT64) AS HPORTALES_MENUDEO,
    SAFE_CAST(TRIM(HPORTALES_RUTA)     AS FLOAT64) AS HPORTALES_RUTA,
    SAFE_CAST(TRIM(HPORTALES_MMAY)     AS FLOAT64) AS HPORTALES_MMAY,
    SAFE_CAST(TRIM(HPORTALES_MAY)      AS FLOAT64) AS HPORTALES_MAYOREO,
    SAFE_CAST(TRIM(HPORTALES_ABASTOS)  AS FLOAT64) AS HPORTALES_ABASTOS,
    SAFE_CAST(TRIM(HINDUSTRIA_PISO)    AS FLOAT64) AS HINDUSTRIA_MENUDEO,
    SAFE_CAST(TRIM(HINDUSTRIA_RUTA)    AS FLOAT64) AS HINDUSTRIA_RUTA,
    SAFE_CAST(TRIM(HINDUSTRIA_MMAY)    AS FLOAT64) AS HINDUSTRIA_MMAY,
    SAFE_CAST(TRIM(HINDUSTRIA_MAY)     AS FLOAT64) AS HINDUSTRIA_MAYOREO,
    SAFE_CAST(TRIM(HINDUSTRIA_ABASTOS) AS FLOAT64) AS HINDUSTRIA_ABASTOS,
    SAFE_CAST(TRIM(HRANCHERO_PISO)     AS FLOAT64) AS HRANCHERO_MENUDEO,
    SAFE_CAST(TRIM(HRANCHERO_RUTA)     AS FLOAT64) AS HRANCHERO_RUTA,
    SAFE_CAST(TRIM(HRANCHERO_MMAY)     AS FLOAT64) AS HRANCHERO_MMAY,
    SAFE_CAST(TRIM(HRANCHERO_MAY)      AS FLOAT64) AS HRANCHERO_MAYOREO,
    SAFE_CAST(TRIM(HRANCHERO_ABASTOS)  AS FLOAT64) AS HRANCHERO_ABASTOS
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_H_20260829`
),

tarifas_bo AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(CHOCOLATE_MENUDEO)  AS FLOAT64) AS CHOCOLATE_MENUDEO,
    SAFE_CAST(TRIM(CHOCOLATE_MAYOREO)  AS FLOAT64) AS CHOCOLATE_MAYOREO,
    SAFE_CAST(TRIM(VAINILLA_MENUDEO)   AS FLOAT64) AS VAINILLA_MENUDEO,
    SAFE_CAST(TRIM(VAINILLA_MAYOREO)   AS FLOAT64) AS VAINILLA_MAYOREO,
    SAFE_CAST(TRIM(CAJETA_MENUDEO)     AS FLOAT64) AS CAJETA_MENUDEO,
    SAFE_CAST(TRIM(CAJETA_MAYOREO)     AS FLOAT64) AS CAJETA_MAYOREO,
    SAFE_CAST(TRIM(SWICH_MENUDEO)      AS FLOAT64) AS SWICH_MENUDEO,
    SAFE_CAST(TRIM(SWICH_MAYOREO)      AS FLOAT64) AS SWICH_MAYOREO,
    SAFE_CAST(TRIM(SW_ROLL_MENUDEO)    AS FLOAT64) AS SW_ROLL_MENUDEO,
    SAFE_CAST(TRIM(SW_ROLL_MAYOREO)    AS FLOAT64) AS SW_ROLL_MAYOREO,
    SAFE_CAST(TRIM(BIG_CHO_MENUDEO)    AS FLOAT64) AS BIG_CHO_MENUDEO,
    SAFE_CAST(TRIM(BIG_CHO_MAYOREO)    AS FLOAT64) AS BIG_CHO_MAYOREO,
    SAFE_CAST(TRIM(BIG_VAI_MENUDEO)    AS FLOAT64) AS BIG_VAI_MENUDEO,
    SAFE_CAST(TRIM(BIG_VAI_MAYOREO)    AS FLOAT64) AS BIG_VAI_MAYOREO,
    SAFE_CAST(TRIM(VUALA_BOLD_MENUDEO) AS FLOAT64) AS VUALA_BOLD_MENUDEO,
    SAFE_CAST(TRIM(VUALA_BOLD_MAYOREO) AS FLOAT64) AS VUALA_BOLD_MAYOREO,
    SAFE_CAST(TRIM(PINA_MENUDEO)       AS FLOAT64) AS PINA_MENUDEO,
    SAFE_CAST(TRIM(PINA_MAYOREO)       AS FLOAT64) AS PINA_MAYOREO,
    SAFE_CAST(TRIM(PMUERTO_MENUDEO)    AS FLOAT64) AS PMUERTO_MENUDEO,
    SAFE_CAST(TRIM(PMUERTO_MAYOREO)    AS FLOAT64) AS PMUERTO_MAYOREO
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_BO_20260829`
),

tarifas_ia AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(CHOP_MENUDEO)  AS FLOAT64) AS CHOP_MENUDEO,
    SAFE_CAST(TRIM(CHOP_MAYOREO)  AS FLOAT64) AS CHOP_MAYOREO,
    SAFE_CAST(TRIM(BALU_MENUDEO)  AS FLOAT64) AS BALU_MENUDEO,
    SAFE_CAST(TRIM(BALU_MAYOREO)  AS FLOAT64) AS BALU_MAYOREO,
    SAFE_CAST(TRIM(WOOFI_MENUDEO) AS FLOAT64) AS WOOFI_MENUDEO,
    SAFE_CAST(TRIM(WOOFI_MAYOREO) AS FLOAT64) AS WOOFI_MAYOREO,
    SAFE_CAST(TRIM(BALTO_MENUDEO) AS FLOAT64) AS BALTO_MENUDEO,
    SAFE_CAST(TRIM(BALTO_MAYOREO) AS FLOAT64) AS BALTO_MAYOREO,
    SAFE_CAST(TRIM(MIXI_MENUDEO)  AS FLOAT64) AS MIXI_MENUDEO,
    SAFE_CAST(TRIM(MIXI_MAYOREO)  AS FLOAT64) AS MIXI_MAYOREO,
    SAFE_CAST(TRIM(BONGO_MENUDEO) AS FLOAT64) AS BONGO_MENUDEO,
    SAFE_CAST(TRIM(BONGO_MAYOREO) AS FLOAT64) AS BONGO_MAYOREO
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_IA_20260829`
),

tarifas_l AS (
  SELECT
    WERKS, LGORT, VKBUR,
    SAFE_CAST(TRIM(LENTERA) AS FLOAT64) AS LENTERA,
    SAFE_CAST(TRIM(LLIGHT)  AS FLOAT64) AS LLIGHT,
    SAFE_CAST(TRIM(LDESLAC) AS FLOAT64) AS LDESLAC
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_L_20260829`
),

tarifas_a AS (
  SELECT
    WERKS, LGORT, VKBUR,
    LTRIM(CAST(MATNR AS STRING), '0') AS matnr_clean,
    COALESCE(
      SAFE_CAST(TRIM(SJABARROTES_SALAMANCA)    AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEON)         AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SALVATIERRA)  AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELAYA)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_QUERETARO)    AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_QROMMAY)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SILAO)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_MORELIA)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_URUAPAN)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEONAB)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEONABMMAY)   AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_LEON2)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_GENARO)       AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_IRAP2)        AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_SANMIGUELALL) AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELPISO)      AS FLOAT64),
      SAFE_CAST(TRIM(SJABARROTES_CELMAY)       AS FLOAT64)
    ) AS tarifa
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_A_20260829`
),

-- ─────────────────────────────────────────────────────────────────────────
-- ALCANCE DE LA SOCIEDAD PAN (agregado 2026-09-08)
--
-- Huevo se factura por DOS sociedades: DBC ($647 M en 2026) y PAN ($10.925 M).
-- Traer PAN entera sería incorrecto: la mayor parte de esa facturación no
-- genera comisión para los comisionistas de DBC.
--
-- EL FILTRO SE DECIDIÓ A PARTIR DE LA TABLA DE TARIFA OFICIAL DE SAP: entra
-- solo la facturación de PAN cuya llave centro+almacén+oficina existe en
-- `proan_ZTSD_OV_COM_H_20260829` con `BUKRS = 'PAN'`. Ese cruce ES la
-- definición de "genera comisión" -- si no hay tarifa, no hay comisión.
-- Medido: reduce $10.925 M -> $2.103 M de facturación en alcance.
--
-- LA PLANTA `PANF` NO BASTA como criterio, aunque lo parezca: el lado PAN de
-- la tarifa es 100% PANF (1 centro, 25 almacenes, 76 oficinas) y PAN3 no
-- aparece nunca ni en la tarifa ni en el mapeo de comisionistas -- pero
-- DENTRO de PANF solo $2.103 M de $7.422 M tiene tarifa. Filtrar por planta
-- sola metería 3,5 veces más facturación de la que corresponde.
alcance_pan AS (
  SELECT DISTINCT WERKS, LGORT, VKBUR
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_H_20260829`
  WHERE BUKRS = 'PAN'
),

-- 2026-09-23: la unidad de la comisión ya no se decide con un IN ('H','IA')
-- suelto aquí -- sale de `dim_base_comision_v1` (`v1_comision_dbc.sql`,
-- sección 3), que es donde vive la confirmación del cliente por división
-- (H y IA: "es por kg", 25 y 26/08/2026) para no enterrar esa regla de
-- negocio en un CASE sin rastro de quién la confirmó.
--
-- DE DÓNDE SALE EL KG (regla corregida el 2026-09-24 -- invierte la preferencia
-- que tenía el 2026-09-23, que daba MARM siempre y `net_weight` solo de
-- fallback). Ahora:
--   - si `net_weight` != `billing_quantity`  -> gana `net_weight`
--   - si son iguales (o es nulo/cero)        -> gana MARM, y si no hay MARM,
--                                               `net_weight` como último recurso
--
-- POR QUÉ. Son dos cosas distintas, no una buena y una mala:
--   - `net_weight` repite literalmente la cantidad facturada en parte de las
--     líneas de huevo (confirmado el 2026-09-23 contra `sap_MARM_20260921`, el
--     maestro del senior): ahí no es un peso, es un eco -- 219.255 líneas /
--     $451 M en 2026. Para ESAS, MARM es lo único que hay.
--   - Pero donde sí difieren, MARM resulta ser el peso NOMINAL de catálogo y
--     `net_weight` el realmente pesado. Medido por material sobre las 2.442.288
--     líneas donde difieren: MARM da siempre un número redondo y el real nunca
--     lo es -- material 12011 MARM=18 kg/caja contra 22,23 reales; 12752 9
--     contra 11,18; 12333 y 12036 20 contra 22,2. El 98,7% de esas líneas caen
--     en el mismo sesgo (`net_weight` entre 1,05 y 2 veces MARM), o sea es
--     estructural, no ruido. La caja "de 18 kg" es una denominación comercial.
--
-- Cobrar comisión sobre el nominal cuando existe el peso real subestimaba el kg
-- de huevo un 13,3% (91,6 M kg -> 103,8 M kg en 2026). IA no se mueve: no tiene
-- cobertura en MARM y ya caía a `net_weight`.
--
-- OJO, PENDIENTE DE NEGOCIO: esto asume que la comisión se paga sobre el peso
-- real embarcado. Si la tarifa del cliente se calibró contra el peso nominal de
-- la caja, lo correcto sería lo contrario. No hay nada en la tarifa de SAP que
-- lo diga -- preguntar.
--
-- `MEINH='KG'` da el kg de UNA unidad base del material vía UMREZ/UMREN
-- (funciona igual si la unidad base YA es kg: ese renglón trae UMREZ=UMREN=1).
--
-- `billing_quantity`, no `stockkeeping_units`, para multiplicar por ese
-- factor: `stockkeeping_units` se había validado (sección 8 del borrador
-- técnico) bajo el supuesto de que la comisión se pagaba por caja en las 5
-- divisiones -- supuesto que ya no es cierto (H/IA son por kg, confirmado por
-- el cliente). Medido mes a mes 2026 en H: `billing_quantity` da el mismo
-- número que `stockkeeping_units` casi exacto (ratio 0.999-1.000 todos los
-- meses, e idéntico en los 36 materiales del bug), mientras que
-- `invoiced_quantity` diverge 1,4%-11,8% por venir en la unidad de venta
-- nativa sin convertir. Con `billing_quantity` no hace falta defender por
-- qué se usa una columna llamada "stockkeeping" para algo que ya no es caja.
--
-- FALLBACK a `net_weight`: ~51 materiales (43 de IA, 8 de H) no tienen
-- NINGUNA fila KG en el maestro -- ni siquiera con el bug, el dato no existe.
-- El cliente dijo "por kg" sin excepciones para H/IA, así que se asume que
-- también lo son y es un hueco del maestro, no otra unidad -- pendiente de
-- confirmar con el cliente la lista concreta. Mientras tanto, mejor el
-- número de siempre que perder la comisión de ventas reales.
marm_kg AS (
  SELECT LTRIM(MATNR, '0') AS matnr_clean, SAFE_DIVIDE(UMREN, UMREZ) AS kg_por_unidad_base
  FROM `proan-quantrue.D10_POSTPROCESSING.sap_MARM_20260921`
  WHERE MEINH = 'KG'
),

facturas AS (
  SELECT
    f.billing_document,
    f.item_number,
    f.billing_date,
    f.company_code                                AS bukrs,
    f.sales_division                              AS gsber,
    f.sales_office                                AS vkbur,
    f.storage_location                            AS lgort,
    f.receiving_plant                             AS werks,
    LTRIM(CAST(f.material_number AS STRING), '0') AS matnr_clean,
    CASE
      WHEN bc.base = 'kg' THEN
        CASE
          -- net_weight es una medición real -> manda (ver el bloque de arriba)
          WHEN f.net_weight IS NOT NULL
               AND CAST(f.net_weight AS FLOAT64) != 0
               AND CAST(f.net_weight AS FLOAT64) != CAST(f.billing_quantity AS FLOAT64)
            THEN CAST(f.net_weight AS FLOAT64)
          -- net_weight es un eco de la cantidad (o no hay) -> nominal de MARM,
          -- y si el material tampoco está en MARM, net_weight como último recurso
          ELSE COALESCE(CAST(f.billing_quantity AS FLOAT64) * m.kg_por_unidad_base,
                        CAST(f.net_weight AS FLOAT64))
        END
      ELSE CAST(f.billing_quantity AS FLOAT64)
    END AS cantidad,
    f.amount_mxn                                  AS importe_mxn,
    f.currency
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
  LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_DBC_base_comision_v1` bc ON bc.division_code = f.sales_division
  LEFT JOIN marm_kg m ON m.matnr_clean = LTRIM(CAST(f.material_number AS STRING), '0')
  WHERE (
      f.company_code = 'DBC'
      -- PAN entra SOLO en huevo y SOLO donde su propia tarifa existe. Ver el
      -- comentario de `alcance_pan` para el porqué del criterio.
      OR (f.company_code = 'PAN'
          AND f.sales_division = 'H'
          AND EXISTS (SELECT 1 FROM alcance_pan k
                      WHERE k.WERKS = f.receiving_plant
                        AND k.LGORT = f.storage_location
                        AND k.VKBUR = f.sales_office))
    )
    AND f.sales_division IN ('H','BO','IA','A','L')
    AND f.document_category = 'M'
    AND f.billing_date >= ventana_desde   -- <- alcance incremental
    AND f.billing_date <= CURRENT_DATE()
    AND f.sales_office  NOT IN ('0001', '0174', '0175', '0181')
    AND f.storage_location NOT IN ('BO28','H793','BO01','H723')
),

base AS (
  SELECT
    f.*,
    s.SETNAME,
    c.tipo_venta,
    c.canal,
    ca.cedis,
    ca.cedis_origen,
    th.HSANJUAN_RUTA,    th.HSANJUAN_MENUDEO,   th.HSANJUAN_MAYOREO,   th.HSANJUAN_MMAY,   th.HSANJUAN_ABASTOS,
    th.HPORTALES_RUTA,   th.HPORTALES_MENUDEO,  th.HPORTALES_MAYOREO,  th.HPORTALES_MMAY,  th.HPORTALES_ABASTOS,
    th.HINDUSTRIA_RUTA,  th.HINDUSTRIA_MENUDEO, th.HINDUSTRIA_MAYOREO, th.HINDUSTRIA_MMAY, th.HINDUSTRIA_ABASTOS,
    th.HRANCHERO_RUTA,   th.HRANCHERO_MENUDEO,  th.HRANCHERO_MAYOREO,  th.HRANCHERO_MMAY,  th.HRANCHERO_ABASTOS,
    tbo.CHOCOLATE_MENUDEO,  tbo.CHOCOLATE_MAYOREO,
    tbo.VAINILLA_MENUDEO,   tbo.VAINILLA_MAYOREO,
    tbo.CAJETA_MENUDEO,     tbo.CAJETA_MAYOREO,
    tbo.SWICH_MENUDEO,      tbo.SWICH_MAYOREO,
    tbo.SW_ROLL_MENUDEO,    tbo.SW_ROLL_MAYOREO,
    tbo.BIG_CHO_MENUDEO,    tbo.BIG_CHO_MAYOREO,
    tbo.BIG_VAI_MENUDEO,    tbo.BIG_VAI_MAYOREO,
    tbo.VUALA_BOLD_MENUDEO, tbo.VUALA_BOLD_MAYOREO,
    tbo.PINA_MENUDEO,       tbo.PINA_MAYOREO,
    tbo.PMUERTO_MENUDEO,    tbo.PMUERTO_MAYOREO,
    tia.CHOP_MENUDEO,  tia.CHOP_MAYOREO,
    tia.BALU_MENUDEO,  tia.BALU_MAYOREO,
    tia.WOOFI_MENUDEO, tia.WOOFI_MAYOREO,
    tia.BALTO_MENUDEO, tia.BALTO_MAYOREO,
    tia.MIXI_MENUDEO,  tia.MIXI_MAYOREO,
    tia.BONGO_MENUDEO, tia.BONGO_MAYOREO,
    tl.LENTERA,        tl.LLIGHT,         tl.LDESLAC,
    ta.tarifa          AS tarifa_a
  FROM facturas f
  LEFT JOIN sets s
    ON f.matnr_clean = s.matnr_clean
  LEFT JOIN cedis c
    ON f.lgort = c.almacen AND f.vkbur = c.oficina
  LEFT JOIN cedis_asignado ca
    ON f.lgort = ca.almacen AND f.vkbur = ca.oficina AND f.werks = ca.planta
  LEFT JOIN tarifas_h th
    ON f.gsber = 'H' AND f.bukrs = th.BUKRS
   AND f.werks = th.WERKS AND f.lgort = th.LGORT AND f.vkbur = th.VKBUR
  LEFT JOIN tarifas_bo tbo
    ON f.gsber = 'BO' AND f.werks = tbo.WERKS AND f.lgort = tbo.LGORT AND f.vkbur = tbo.VKBUR
  LEFT JOIN tarifas_ia tia
    ON f.gsber = 'IA' AND f.werks = tia.WERKS AND f.lgort = tia.LGORT AND f.vkbur = tia.VKBUR
  LEFT JOIN tarifas_l tl
    ON f.gsber = 'L' AND f.werks = tl.WERKS AND f.lgort = tl.LGORT AND f.vkbur = tl.VKBUR
  LEFT JOIN tarifas_a ta
    ON f.gsber = 'A' AND f.werks = ta.WERKS AND f.lgort = ta.LGORT AND f.vkbur = ta.VKBUR
   AND f.matnr_clean = ta.matnr_clean
),

-- 2026-09-08: TIPO DE VENTA (y por lo tanto la tarifa) SE TOMA DE LA PROPIA
-- TABLA DE TARIFA, no de `dim_cedis_v1`/`dim_cedis_oficina_v1`. Motivo: esa
-- dimensión es una fuente aparte que puede quedar desactualizada frente a la
-- tarifa oficial de SAP -- ya probado en huevo con un caso real (H719/0028:
-- para DBC decía "VTA EN RUTA" y sí correspondía, pero para PAN el mismo
-- almacén+oficina es "MED MAYOREO" -- dim_cedis no distingue sociedad y solo
-- acertaba para una de las dos). Encontrado también H701/0121 y H707/0106,
-- errados para ambas sociedades -- y muchos más una vez medido a fondo: en
-- total $110,4 M que caían en "sin tarifa para esa llave" tenían tarifa real
-- esperando bajo el tipo de venta correcto ($5,5 M de hueco genuino en huevo
-- se quedan sin tarifa igual -- ver comentario del encabezado del archivo).
--
-- Aplicado a las 3 divisiones donde la tarifa distingue tipo de venta/canal
-- por columnas (H, BO, IA) -- Leche y Abarrotes no tienen esa distinción en
-- su tabla de tarifa, así que ahí no hay nada que resolver y siguen igual.
-- Regla por SET: si dim_cedis apunta a una columna que SÍ tiene tarifa, se
-- respeta (cubre los sitios con más de una columna con valor -- 2 de 360
-- llaves en H, 0 en BO/IA -- donde la tarifa sola no alcanza para decidir).
-- Si dim_cedis no confirma nada (vacío o apunta a una columna vacía), se toma
-- la tarifa directo de la única columna con valor. En huevo, para H únicamente
-- se sobreescribe también el tipo de venta mostrado (es la fuente real de la
-- tarifa); en botana/alimento el tipo de venta mostrado sigue viniendo de
-- dim_cedis sin cambio (informativo, la tarifa ya no depende de él).
resuelto AS (
  SELECT
    *,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HSANJUAN_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HSANJUAN_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HSANJUAN_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HSANJUAN_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HSANJUAN_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HSANJUAN_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HSANJUAN_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HSANJUAN_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HSANJUAN_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HSANJUAN_ABASTOS AS tarifa)
      WHEN HSANJUAN_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HSANJUAN_RUTA    AS tarifa)
      WHEN HSANJUAN_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HSANJUAN_MENUDEO AS tarifa)
      WHEN HSANJUAN_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HSANJUAN_MAYOREO AS tarifa)
      WHEN HSANJUAN_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HSANJUAN_MMAY    AS tarifa)
      WHEN HSANJUAN_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HSANJUAN_ABASTOS AS tarifa)
    END AS HSANJUAN_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HPORTALES_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HPORTALES_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HPORTALES_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HPORTALES_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HPORTALES_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HPORTALES_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HPORTALES_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HPORTALES_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HPORTALES_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HPORTALES_ABASTOS AS tarifa)
      WHEN HPORTALES_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HPORTALES_RUTA    AS tarifa)
      WHEN HPORTALES_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HPORTALES_MENUDEO AS tarifa)
      WHEN HPORTALES_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HPORTALES_MAYOREO AS tarifa)
      WHEN HPORTALES_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HPORTALES_MMAY    AS tarifa)
      WHEN HPORTALES_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HPORTALES_ABASTOS AS tarifa)
    END AS HPORTALES_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HINDUSTRIA_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HINDUSTRIA_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HINDUSTRIA_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HINDUSTRIA_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HINDUSTRIA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HINDUSTRIA_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HINDUSTRIA_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HINDUSTRIA_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HINDUSTRIA_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HINDUSTRIA_ABASTOS AS tarifa)
      WHEN HINDUSTRIA_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HINDUSTRIA_RUTA    AS tarifa)
      WHEN HINDUSTRIA_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HINDUSTRIA_MENUDEO AS tarifa)
      WHEN HINDUSTRIA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HINDUSTRIA_MAYOREO AS tarifa)
      WHEN HINDUSTRIA_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HINDUSTRIA_MMAY    AS tarifa)
      WHEN HINDUSTRIA_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HINDUSTRIA_ABASTOS AS tarifa)
    END AS HINDUSTRIA_r,
    CASE
      WHEN tipo_venta = 'VTA EN RUTA' AND HRANCHERO_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA'  AS tipo_venta, HRANCHERO_RUTA    AS tarifa)
      WHEN tipo_venta = 'VTA EN PISO' AND HRANCHERO_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO'  AS tipo_venta, HRANCHERO_MENUDEO AS tarifa)
      WHEN tipo_venta = 'MAYOREO'     AND HRANCHERO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'      AS tipo_venta, HRANCHERO_MAYOREO AS tarifa)
      WHEN tipo_venta = 'MED MAYOREO' AND HRANCHERO_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO'  AS tipo_venta, HRANCHERO_MMAY    AS tarifa)
      WHEN tipo_venta = 'ABASTOS'     AND HRANCHERO_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'      AS tipo_venta, HRANCHERO_ABASTOS AS tarifa)
      WHEN HRANCHERO_RUTA    IS NOT NULL THEN STRUCT('VTA EN RUTA' AS tipo_venta, HRANCHERO_RUTA    AS tarifa)
      WHEN HRANCHERO_MENUDEO IS NOT NULL THEN STRUCT('VTA EN PISO' AS tipo_venta, HRANCHERO_MENUDEO AS tarifa)
      WHEN HRANCHERO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO'     AS tipo_venta, HRANCHERO_MAYOREO AS tarifa)
      WHEN HRANCHERO_MMAY    IS NOT NULL THEN STRUCT('MED MAYOREO' AS tipo_venta, HRANCHERO_MMAY    AS tarifa)
      WHEN HRANCHERO_ABASTOS IS NOT NULL THEN STRUCT('ABASTOS'     AS tipo_venta, HRANCHERO_ABASTOS AS tarifa)
    END AS HRANCHERO_r,

    CASE
      WHEN canal = 'MENUDEO' AND CHOCOLATE_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOCOLATE_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CHOCOLATE_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOCOLATE_MAYOREO AS tarifa)
      WHEN CHOCOLATE_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOCOLATE_MENUDEO AS tarifa)
      WHEN CHOCOLATE_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOCOLATE_MAYOREO AS tarifa)
    END AS CHOCOLATE_r,
    CASE
      WHEN canal = 'MENUDEO' AND VAINILLA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VAINILLA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND VAINILLA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VAINILLA_MAYOREO AS tarifa)
      WHEN VAINILLA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VAINILLA_MENUDEO AS tarifa)
      WHEN VAINILLA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VAINILLA_MAYOREO AS tarifa)
    END AS VAINILLA_r,
    CASE
      WHEN canal = 'MENUDEO' AND CAJETA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CAJETA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CAJETA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CAJETA_MAYOREO AS tarifa)
      WHEN CAJETA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CAJETA_MENUDEO AS tarifa)
      WHEN CAJETA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CAJETA_MAYOREO AS tarifa)
    END AS CAJETA_r,
    CASE
      WHEN canal = 'MENUDEO' AND SWICH_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SWICH_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND SWICH_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SWICH_MAYOREO AS tarifa)
      WHEN SWICH_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SWICH_MENUDEO AS tarifa)
      WHEN SWICH_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SWICH_MAYOREO AS tarifa)
    END AS SWICH_r,
    CASE
      WHEN canal = 'MENUDEO' AND SW_ROLL_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SW_ROLL_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND SW_ROLL_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SW_ROLL_MAYOREO AS tarifa)
      WHEN SW_ROLL_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, SW_ROLL_MENUDEO AS tarifa)
      WHEN SW_ROLL_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, SW_ROLL_MAYOREO AS tarifa)
    END AS SW_ROLL_r,
    CASE
      WHEN canal = 'MENUDEO' AND BIG_CHO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_CHO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BIG_CHO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_CHO_MAYOREO AS tarifa)
      WHEN BIG_CHO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_CHO_MENUDEO AS tarifa)
      WHEN BIG_CHO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_CHO_MAYOREO AS tarifa)
    END AS BIG_CHO_r,
    CASE
      WHEN canal = 'MENUDEO' AND BIG_VAI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_VAI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BIG_VAI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_VAI_MAYOREO AS tarifa)
      WHEN BIG_VAI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BIG_VAI_MENUDEO AS tarifa)
      WHEN BIG_VAI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BIG_VAI_MAYOREO AS tarifa)
    END AS BIG_VAI_r,
    CASE
      WHEN canal = 'MENUDEO' AND VUALA_BOLD_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VUALA_BOLD_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND VUALA_BOLD_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VUALA_BOLD_MAYOREO AS tarifa)
      WHEN VUALA_BOLD_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, VUALA_BOLD_MENUDEO AS tarifa)
      WHEN VUALA_BOLD_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, VUALA_BOLD_MAYOREO AS tarifa)
    END AS VUALA_BOLD_r,
    CASE
      WHEN canal = 'MENUDEO' AND PINA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PINA_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND PINA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PINA_MAYOREO AS tarifa)
      WHEN PINA_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PINA_MENUDEO AS tarifa)
      WHEN PINA_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PINA_MAYOREO AS tarifa)
    END AS PINA_r,
    CASE
      WHEN canal = 'MENUDEO' AND PMUERTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PMUERTO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND PMUERTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PMUERTO_MAYOREO AS tarifa)
      WHEN PMUERTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, PMUERTO_MENUDEO AS tarifa)
      WHEN PMUERTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, PMUERTO_MAYOREO AS tarifa)
    END AS PMUERTO_r,

    CASE
      WHEN canal = 'MENUDEO' AND CHOP_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOP_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND CHOP_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOP_MAYOREO AS tarifa)
      WHEN CHOP_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, CHOP_MENUDEO AS tarifa)
      WHEN CHOP_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, CHOP_MAYOREO AS tarifa)
    END AS CHOP_r,
    CASE
      WHEN canal = 'MENUDEO' AND BALU_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALU_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BALU_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALU_MAYOREO AS tarifa)
      WHEN BALU_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALU_MENUDEO AS tarifa)
      WHEN BALU_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALU_MAYOREO AS tarifa)
    END AS BALU_r,
    CASE
      WHEN canal = 'MENUDEO' AND WOOFI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, WOOFI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND WOOFI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, WOOFI_MAYOREO AS tarifa)
      WHEN WOOFI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, WOOFI_MENUDEO AS tarifa)
      WHEN WOOFI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, WOOFI_MAYOREO AS tarifa)
    END AS WOOFI_r,
    CASE
      WHEN canal = 'MENUDEO' AND BALTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALTO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BALTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALTO_MAYOREO AS tarifa)
      WHEN BALTO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BALTO_MENUDEO AS tarifa)
      WHEN BALTO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BALTO_MAYOREO AS tarifa)
    END AS BALTO_r,
    CASE
      WHEN canal = 'MENUDEO' AND MIXI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, MIXI_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND MIXI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, MIXI_MAYOREO AS tarifa)
      WHEN MIXI_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, MIXI_MENUDEO AS tarifa)
      WHEN MIXI_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, MIXI_MAYOREO AS tarifa)
    END AS MIXI_r,
    CASE
      WHEN canal = 'MENUDEO' AND BONGO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BONGO_MENUDEO AS tarifa)
      WHEN canal = 'MAYOREO' AND BONGO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BONGO_MAYOREO AS tarifa)
      WHEN BONGO_MENUDEO IS NOT NULL THEN STRUCT('MENUDEO' AS canal, BONGO_MENUDEO AS tarifa)
      WHEN BONGO_MAYOREO IS NOT NULL THEN STRUCT('MAYOREO' AS canal, BONGO_MAYOREO AS tarifa)
    END AS BONGO_r
  FROM base
),

con_tarifa AS (
  SELECT
    * EXCEPT (
      HSANJUAN_r, HPORTALES_r, HINDUSTRIA_r, HRANCHERO_r,
      CHOCOLATE_r, VAINILLA_r, CAJETA_r, SWICH_r, SW_ROLL_r, BIG_CHO_r, BIG_VAI_r, VUALA_BOLD_r, PINA_r, PMUERTO_r,
      CHOP_r, BALU_r, WOOFI_r, BALTO_r, MIXI_r, BONGO_r
    ),
    CASE
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   THEN HSANJUAN_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  THEN HPORTALES_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' THEN HINDUSTRIA_r.tarifa
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  THEN HRANCHERO_r.tarifa

      WHEN gsber = 'BO' AND SETNAME = 'CHOCOLATE'  THEN CHOCOLATE_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'VAINILLA'   THEN VAINILLA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'CAJETA'     THEN CAJETA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'SWICH'      THEN SWICH_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'SW_ROLL'    THEN SW_ROLL_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'BIG_CHO'    THEN BIG_CHO_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'BIG_VAI'    THEN BIG_VAI_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'VUALA_BOLD' THEN VUALA_BOLD_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'PINA'       THEN PINA_r.tarifa
      WHEN gsber = 'BO' AND SETNAME = 'PMUERTO'    THEN PMUERTO_r.tarifa

      WHEN gsber = 'IA' AND SETNAME = 'CHOP'  THEN CHOP_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BALU'  THEN BALU_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'WOOFI' THEN WOOFI_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BALTO' THEN BALTO_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'MIXI'  THEN MIXI_r.tarifa
      WHEN gsber = 'IA' AND SETNAME = 'BONGO' THEN BONGO_r.tarifa

      WHEN gsber = 'L' AND SETNAME = 'LENTERA' THEN LENTERA
      WHEN gsber = 'L' AND SETNAME = 'LLIGHT'  THEN LLIGHT
      WHEN gsber = 'L' AND SETNAME = 'LDESLAC' THEN LDESLAC

      WHEN gsber = 'A' THEN tarifa_a
    END AS tarifa,
    -- Tipo de venta resuelto: para H, viene del mismo struct que resolvió la
    -- tarifa (self-healed contra dm_cedis). Para BO/IA/L/A no cambia -- su
    -- tabla de tarifa no distingue más que canal (BO/IA) o nada (L/A), así
    -- que el tipo de venta que se muestra sigue siendo el de dm_cedis.
    CASE
      WHEN gsber = 'H' AND SETNAME = 'HSANJUAN'   THEN HSANJUAN_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HPORTALES'  THEN HPORTALES_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HINDUSTRIA' THEN HINDUSTRIA_r.tipo_venta
      WHEN gsber = 'H' AND SETNAME = 'HRANCHERO'  THEN HRANCHERO_r.tipo_venta
      ELSE tipo_venta
    END AS tipo_venta_resuelto
  FROM resuelto
),

-- Cobro: mismas dos CTEs que v1_flujo_producto_dbc_prototipo_v2.sql. Denominador
-- del prorrateo (con_impuestos) y el pago por factura (document_category='M').
--
-- 2026-09-23: el WHERE ahora es el MISMO criterio que `facturas` (alcance_pan +
-- división en operación + fuera de venta directa/almacén central), en vez de
-- solo `company_code IN ('DBC','PAN')`. Sin esto, una factura PAN fuera de
-- alcance_pan, o de una división que no paga comisión, o de un almacén
-- central, inflaba este denominador sin que su propia línea apareciera nunca
-- en el numerador. Verificado contra BigQuery: ningún billing_document 2026
-- mezcla división, estado de alcance_pan, ni venta-directa/almacén-central
-- entre sus líneas (0 casos en los tres), así que esto no cambia ninguna cifra
-- ya calculada -- es blindaje para el día que ese supuesto deje de cumplirse.
factura_totales AS (
  SELECT
    billing_document,
    SUM(CAST(amount_total_mxn AS FLOAT64)) AS con_impuestos
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
  WHERE (
      f.company_code = 'DBC'
      OR (f.company_code = 'PAN'
          AND f.sales_division = 'H'
          AND EXISTS (SELECT 1 FROM alcance_pan k
                      WHERE k.WERKS = f.receiving_plant
                        AND k.LGORT = f.storage_location
                        AND k.VKBUR = f.sales_office))
    )
    AND f.sales_division IN ('H','BO','IA','A','L')
    -- AQUÍ SÍ VA 'M' A SECAS, a diferencia de `factura_totales_v1` en
    -- v1_flujo_producto_dbc.sql, que admite M+P+S (2026-09-24). No es un
    -- descuido: allí esa CTE también decide QUÉ documentos entran en cobrado,
    -- así que dejar fuera P/S perdía cobros reales. Aquí no -- `pago_factura`
    -- no filtra contra esta lista, solo se pega por LEFT JOIN a las líneas de
    -- `facturas`, que ya son M. Una nota de débito no genera comisión, así que
    -- no tiene línea donde colgarse y su pago no entra por ningún lado.
    -- Numerador y denominador quedan sobre el mismo universo: solo facturas.
    AND f.document_category = 'M'
    AND f.sales_office NOT IN ('0001', '0174', '0175', '0181')
    AND f.storage_location NOT IN ('BO28','H793','BO01','H723')
  GROUP BY billing_document
),

-- debit_lg: lado de BSAD que trae la factura contra la que se aplicó el
-- cobro (el otro lado, credit_lg, es la entrada del pago en sí). SUM en vez
-- de ANY_VALUE porque puede haber más de una línea por factura (pagos
-- parciales en fechas distintas).
pago_factura AS (
  SELECT
    VBELN_billing_document AS billing_document,
    MIN(AUGDT_clearing_dt) AS fecha_cobro,
    SUM(DMBTR_amount_in_local_currency) AS pagado
  -- Una fila por línea contable: si se compensó dos veces (anulada y rehecha), solo la más reciente.
  FROM (
    SELECT *
    FROM `proan-quantrue.D30_INTEGRATION.sap_bsad_cleared_items`
    WHERE BUKRS_company_code IN ('DBC','PAN') AND debit_lg
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY BUKRS_company_code, GJAHR_fiscal_year, BELNR_account_document_number, BUZEI_item_number
      ORDER BY AUGDT_clearing_dt DESC, AUGBL_document_number DESC) = 1
  )
  WHERE BUKRS_company_code IN ('DBC','PAN')
    AND debit_lg
    AND VBELN_billing_document IS NOT NULL AND VBELN_billing_document != ''
    AND AUGDT_clearing_dt >= '2026-01-01'
  GROUP BY VBELN_billing_document
)

SELECT
  t.billing_document,
  t.item_number,
  t.billing_date,
  t.bukrs,
  t.gsber           AS division,
  t.vkbur           AS oficina_ventas,
  t.lgort           AS almacen,
  t.werks           AS planta,
  t.cedis,
  t.cedis_origen,
  t.matnr_clean     AS matnr,
  t.SETNAME         AS set_material,
  t.tipo_venta_resuelto AS tipo_venta,
  t.canal,
  t.cantidad,
  t.importe_mxn,
  t.tarifa,
  CASE
    WHEN t.tarifa              IS NOT NULL THEN 'OK'
    WHEN t.SETNAME              IS NULL    THEN 'SIN_SET'
    WHEN t.tipo_venta_resuelto  IS NULL    THEN 'SIN_CEDIS'
    ELSE 'SIN_TARIFA'
  END AS status,

  ROUND(t.cantidad * t.tarifa, 2) AS comision_mxn,

  p.billing_document IS NOT NULL AS se_cobro,
  ROUND(t.importe_mxn * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2) AS monto_cobrado,
  ROUND(t.cantidad    * SAFE_DIVIDE(p.pagado, ft.con_impuestos), 2) AS cantidad_cobrada,
  -- Comisión "con cobro registrado": tarifa × lo efectivamente cobrado. 0 si
  -- nada se ha cobrado todavía (no NULL: NULL es "sin tarifa", 0 es "con
  -- tarifa, sin cobro").
  ROUND(t.cantidad * t.tarifa * COALESCE(SAFE_DIVIDE(p.pagado, ft.con_impuestos), 0), 2) AS comision_cobrada,
  p.fecha_cobro
FROM con_tarifa t
LEFT JOIN factura_totales ft ON ft.billing_document = t.billing_document
LEFT JOIN pago_factura p     ON p.billing_document   = t.billing_document
-- Sin `ORDER BY` final: BigQuery no admite ordenar el resultado de un
-- `CREATE TABLE ... AS` particionado ("Result of ORDER BY queries cannot be
-- partitioned by field"). Tampoco hacía falta -- el orden físico lo da ahora
-- el `CLUSTER BY`, y ninguna consulta de aguas abajo dependía de él.
;

ASSERT (
  SELECT COUNT(*) FROM `proan-quantrue.D50_AGGREGATE.DBC_comisiones_calculadas_cobro`
  WHERE billing_date >= ventana_desde
) > 0 AS 'DBC_comisiones_calculadas_cobro: la ventana quedó vacía tras el refresco';
