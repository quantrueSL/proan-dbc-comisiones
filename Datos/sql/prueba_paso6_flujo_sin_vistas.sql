CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc_test` AS
WITH

-- 2026-09-24 (PRUEBA paso 6): los cuatro escalones de CEDIS pasan de ser vistas
-- sueltas (dim_cedis_v1 / _almacen_v1 / _nombre_v1 / _oficina_v1) a CTEs de esta
-- misma vista. Copia literal de sus definiciones, sin tocar reglas: mismos
-- desempates, misma exclusión de oficinas cajón de sastre, misma normalización
-- de nombre. El objetivo es poder retirar esas cuatro vistas -- comisiones y
-- conciliación ya dejaron de usarlas (pasos 3-5).
-- Desempate de las llaves ambiguas de dm_cedis (2026-09-24). Copia literal del
-- mismo CTE en v1_comision_dbc_completo_cobro.sql -- ahí está el comentario
-- largo con la evidencia. Resumen: `dm_cedis` da dos cedis para BO11/0122 y
-- H717/0122 ("Celaya Agustin" / "Celaya Genaro") y el ORDER BY sector no los
-- separa; se desempata con el comisionista de esa oficina, que es la llave ya
-- validada contra el pago real de BSAK. Para 0122 sale Genaro.
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
      FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comisionista`
      WHERE persona IS NOT NULL AND persona != ''
    ) p ON p.oficina = k.oficina
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
      l.origen,
      COALESCE(c.cedis, l.nombre_cedis) AS cedis,
      c.cedis IS NOT NULL AS grafia_del_catalogo,
      ROW_NUMBER() OVER (
        PARTITION BY l.almacen
        ORDER BY IF(l.origen = 'deducido', 0, 1), l.planta DESC, l.nombre_cedis
      ) AS rn
    FROM (
      SELECT planta, almacen, nombre_cedis, origen,
             UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(nombre_cedis, NFKD), r'[^a-z0-9]', '')) AS clave
      FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_almacen_nombre`
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

plantas_dbc AS (
  -- Lista corregida contra V3 de v1_verificaciones.sql (DISTINCT receiving_plant
  -- WHERE company_code='DBC'): la original (sección 2 del borrador) no traía
  -- H7DU ni H7TX -- con la lista vieja, esas dos plantas quedaban excluidas de
  -- "vendido" (que depende de esta lista al no tener company_code propio).
  SELECT planta FROM UNNEST([
    'DBCF','DBC1','DBC3','H7LA','H7L1','H7L2','H7SL','H7SI','H7AG','H7SM',
    'H7QU','H7CE','H7SA','H7MI','H7MO','H7UR','H7ZA','H7IR','H7SJ','H7DU','H7TX'
  ]) AS planta
),

-- Mismo criterio, misma tabla, que `alcance_pan` en
-- `v1_comision_dbc_completo_cobro.sql` -- no se reinventa el filtro de PAN en
-- dos sitios distintos que puedan divergir.
alcance_pan AS (
  SELECT DISTINCT WERKS, LGORT, VKBUR
  FROM `proan-quantrue.D00_SANDBOX.proan_ZTSD_OV_COM_H_20260829`
  WHERE BUKRS = 'PAN'
),

-- `sap_2lis_13_vditm_billing_document_item` es a nivel LÍNEA (lo dice el
-- nombre): puede haber varias líneas por `billing_document`, y en teoría con
-- distinto centro/almacén/oficina cada una. La rama "cobrado" solo necesita
-- heredar el sitio de la factura (sección 4.1: sap_pago no lo trae), no
-- multiplicar `paid_amount_mxn` por cada línea -- por eso NO se hace join
-- directo contra la tabla de líneas, sino contra esta versión deduplicada
-- (un renglón por factura). Confirmado con datos reales (V4 de
-- v1_verificaciones.sql): SÍ existen facturas repartidas entre 2 almacenes
-- (mismo centro, misma oficina) -- la regla de desempate (primer almacén en
-- orden alfabético) sigue siendo PROVISIONAL, pendiente de que el negocio
-- diga cómo repartir esos casos.
-- 2026-09-07: se agregan sales_division/distribution_channel (mismo criterio
-- de desempate) para que "cobrado" ya no dependa de business_area_code /
-- distribution_channel propios de sap_pago -- sap_bsad_cleared_items (la
-- nueva fuente) no trae un campo de canal, y su GSBER llega vacío casi
-- siempre en las cuentas que usamos.
-- `sociedad` (2026-09-10) viaja con el sitio porque las dos nacen de la misma
-- línea de factura -- así "cobrado" hereda de qué sociedad es el pago sin
-- tener que volver a tocar `sap_bsad_cleared_items` (que no trae sociedad
-- propia confiable).
factura_sitio_v1 AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      billing_document,
      company_code AS sociedad,
      receiving_plant,
      storage_location,
      sales_office,
      sales_division,
      distribution_channel,
      ROW_NUMBER() OVER (PARTITION BY billing_document ORDER BY receiving_plant, storage_location, sales_office) AS rn
    FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  )
  WHERE rn = 1
),

-- Totales por factura: el denominador del prorrateo de "cobrado" y de dónde
-- salen sus cajas. Se suma sobre TODAS las líneas de la factura, sin filtro de
-- fecha ni de planta, porque lo que se necesita es el valor completo del
-- documento que se está pagando.
--
-- OJO CON QUÉ TOTAL SE USA: el pago se compara contra `amount_total_mxn` (con
-- impuestos), no contra el neto. Medido sobre las 39.967 compensaciones de 2026:
-- el pagado cuadra EXACTO con el total con impuestos en el 100% de los casos
-- (ratio 1,00; ninguno por encima ni por debajo), mientras contra el neto
-- salía un p99 de 1,16 — que era el IVA, no un sobrepago. Prorratear contra el
-- neto habría inflado las cajas cobradas hasta un 16%.
--
-- 2026-09-10: el WHERE ahora es el MISMO criterio DBC+PAN(alcance_pan) que
-- `facturas` en `v1_comision_dbc_completo_cobro.sql` -- este CTE es también el
-- filtro real de qué facturas puede "encontrar" `pago_factura_v1` de aquí en
-- adelante (ver el nuevo `WHERE ... IN (SELECT billing_document FROM
-- factura_totales_v1)` de ese CTE, más abajo): así un pago de PAN fuera de
-- huevo/alcance_pan (que puede ser cualquiera de los $107,800 M de PANF que no
-- son huevo de la lista oficial) no se cuela disfrazado de "cobrado sin sitio
-- conocido" como antes pasaba con el hueco de NULL -- simplemente no entra.
factura_totales_v1 AS (
  SELECT
    billing_document,
    SUM(CAST(amount_mxn AS FLOAT64)) AS neto,
    SUM(CAST(amount_total_mxn AS FLOAT64)) AS con_impuestos,
    SUM(CAST(stockkeeping_units AS FLOAT64)) AS cajas
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  WHERE (
      company_code = 'DBC'
      OR (company_code = 'PAN'
          AND sales_division = 'H'
          AND EXISTS (SELECT 1 FROM alcance_pan k
                      WHERE k.WERKS = receiving_plant
                        AND k.LGORT = storage_location
                        AND k.VKBUR = sales_office))
    )
    -- Categorías que se cobran (ver el comentario largo en
    -- v1_flujo_producto_dbc.sql). P y S son deuda real compensada en BSAD
    -- ($774.352 y $507.530 en 2026); N es ruido (10 docs / $6.047) y O nunca
    -- aparece. Dejarlo en 'M' a secas perdía 112 facturas / $1.286.141,12.
    AND document_category IN ('M', 'P', 'S')
  GROUP BY billing_document
),

-- 2026-09-07: fuente cambiada de `sap_pago` a `sap_bsad_cleared_items`
-- (cobertura del facturado: 17% → 87%, validado a nivel de monto -- ver
-- v1_comision_dbc_completo_cobro.sql para el detalle de esa validación).
-- `debit_lg` es el lado de BSAD que trae la factura contra la que se aplicó
-- el cobro (el otro lado, credit_lg, es la entrada del pago en sí). `SUM` en
-- vez de `ANY_VALUE` porque aquí sí puede haber más de una línea por factura
-- (pagos parciales en fechas distintas) -- a diferencia de `sap_pago`, que
-- nunca los tuvo (ver el párrafo del triple conteo, más abajo -- sigue
-- describiendo `sap_pago`, ya no la fuente real, pero la razón del
-- `GROUP BY billing_document` y del prorrateo por `con_impuestos` no cambió).
--
-- Historia (con sap_pago, ya no la fuente): un triple conteo inflaba
-- "cobrado" un 53% -- (1) cada partida de una compensación traía el mismo
-- `paid_amount_mxn`, y (2) la misma factura reaparecía en varias
-- compensaciones con el importe completo otra vez (479 facturas, $230,5 M).
-- Con `sap_pago`, sumar por factura resultaba en $1.229,3 M contra $1.884,7 M
-- de sumar cada renglón -- la única cifra defendible era la de una vez por
-- factura, y con `sap_pago` no había cobros parciales reales (los 39.967
-- pagos cuadraban exactos con su factura).
-- 2026-09-10: `BUKRS_company_code IN ('DBC','PAN')` SOLO no bastaría -- BSAD
-- de PAN trae compensaciones de TODO su negocio, no solo huevo/alcance_pan.
-- El `AND ... IN (SELECT billing_document FROM factura_totales_v1)` es lo que
-- de verdad acota: esa lista YA es DBC completo + PAN-huevo-alcance_pan (ver
-- el CTE de arriba), así que un pago fuera de ese alcance simplemente no
-- entra aquí -- no llega a existir la fila, en vez de colarse sin sitio
-- conocido como antes. Esto también es el fix del hueco de `NULL` que se
-- encontró el 2026-09-10 (pagos sin factura cruzada que se contaban igual que
-- los confirmados): con este filtro, todo lo que sale de `pago_factura_v1`
-- SIEMPRE tiene una fila en `factura_totales_v1`, así que el `LEFT JOIN` de
-- más abajo ya no puede fallar y el `COALESCE(..., g.pagado)` queda como red
-- de seguridad muerta, no como vía de escape real.
pago_factura_v1 AS (
  SELECT
    VBELN_billing_document AS billing_document,
    MIN(AUGDT_clearing_dt) AS fecha,
    SUM(DMBTR_amount_in_local_currency) AS pagado
  FROM `proan-quantrue.D30_INTEGRATION.sap_bsad_cleared_items`
  WHERE BUKRS_company_code IN ('DBC', 'PAN')
    AND debit_lg
    AND VBELN_billing_document IS NOT NULL AND VBELN_billing_document != ''
    AND AUGDT_clearing_dt >= '2026-01-01'
    AND VBELN_billing_document IN (SELECT billing_document FROM factura_totales_v1)
  GROUP BY VBELN_billing_document
)

-- Vendido ---------------------------------------------------------------
SELECT
  'vendido' AS fase,
  -- PAN solo vende huevo por la planta PANF (2026-09-22, ver sección 2) -- con
  -- una sola planta de PAN y ninguna en `plantas_dbc`, WERKS ya basta para
  -- etiquetar sociedad sin tocar BUKRS_VF/VKORG.
  IF(p.WERKS = 'PANF', 'PAN', 'DBC') AS sociedad,
  CAST(k.ERDAT AS DATE) AS fecha,           -- confirmado vía INFORMATION_SCHEMA: ERDAT existe en ambas (VBAK y VBAP); se toma de la cabecera (k) por ser la fecha de creación del pedido
  CAST(p.VBELN AS STRING) AS documento,
  CAST(p.POSNR AS STRING) AS linea,
  p.SPART AS division_code,                 -- confirmado: SPART existe en VBAP (a nivel línea), no hace falta tomarlo de la cabecera
  ba.business_area_name AS division,        -- confirmado: dm_business_area usa business_area_code (llave) / business_area_name (descripción), no sales_division
  k.VTWEG AS canal_code,                    -- confirmado: VTWEG SOLO existe en VBAK (cabecera), no en VBAP
  -- Cuatro escalones, del más específico al más flojo (secciones 1b, 1c, 1d).
  -- `cedis_origen` dice cuál ganó, y con él se reproduce cualquier versión
  -- anterior: quitando 'solo oficina' se vuelve al resultado del 21/08, y
  -- quitando además los otros dos, al original sin fallbacks.
  COALESCE(dc.cedis, dal.cedis, dma.cedis, dco.cedis) AS cedis,
  -- El tipo de venta NO tiene cuatro escalones: ni el almacén ni el mapeo
  -- manual lo determinan (un almacén sirve varios tipos según la oficina).
  COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
  CASE WHEN dc.cedis IS NOT NULL THEN 'almacen+oficina'
       WHEN dal.cedis IS NOT NULL THEN 'solo almacen'
       WHEN dma.cedis IS NOT NULL THEN 'lista de nombres'
       WHEN dco.cedis IS NOT NULL THEN 'solo oficina'
  END AS cedis_origen,
  -- Almacén central: el cliente confirmó el 25/08/2026 que estos cuatro NO
  -- pasan por ningún CEDIS y NO generan comisión para nadie. No es que les
  -- falte el dato: es que la respuesta correcta es "ninguno". Son $832,4 M
  -- facturados ($656,5 M dentro de las cinco divisiones que DBC opera), el
  -- 66,4% de todo lo que salía sin CEDIS. Se marcan en vez de borrarse para que
  -- el total siga cuadrando y se pueda auditar cuánto se está dejando fuera.
  p.LGORT IN ('BO28', 'BO01', 'H723', 'H793') AS almacen_central,
  k.VKBUR AS oficina,                       -- confirmado: VKBUR SOLO existe en VBAK (cabecera), no en VBAP — este era el error reportado
  p.WERKS AS planta,
  p.LGORT AS almacen,
  p.MATNR AS material_number,
  CAST(p.KWMENG AS FLOAT64) AS cantidad,
  p.VRKME AS unidad,                        -- confirmado: VRKME es la unidad de venta real en VBAP (ya no es TODO)
  -- Cantidad en la unidad base del material, el equivalente exacto del
  -- `stockkeeping_units` de facturado. VBAP sí trae la conversión: UMVKZ/UMVKN
  -- es el factor de unidad de venta -> unidad base, y está informado en el 100%
  -- de las líneas DBC de 2026 (ni un NULL, ni un denominador cero). Coincide con
  -- `KLMENG` al cuarto decimal donde KLMENG no es cero, y se prefiere la
  -- multiplicación porque KLMENG es cantidad *confirmada* y viene a cero en
  -- unas 430 líneas.
  CAST(p.KWMENG * SAFE_DIVIDE(p.UMVKZ, p.UMVKN) AS FLOAT64) AS cantidad_cajas,
  CAST(p.NETWR AS FLOAT64) AS monto,        -- indicativo, NO confiable (sección 4.3) — no usar para comisión ni para cuadrar contra lo cobrado
  FALSE AS monto_confiable
FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP` p
JOIN `proan-quantrue.D30_INTEGRATION.sap_VBAK` k ON k.VBELN = p.VBELN
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = p.SPART
LEFT JOIN esc_1_almacen_oficina dc ON dc.almacen = p.LGORT AND dc.oficina = k.VKBUR
-- Cada escalón entra solo donde falló el anterior, y la condición va en el ON y
-- no en un CASE posterior: así una línea que ya cruzó no toca las dimensiones
-- de repuesto ni por casualidad.
LEFT JOIN esc_2_almacen dal
       ON dc.cedis IS NULL AND dal.almacen = p.LGORT
LEFT JOIN esc_3_nombre dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = p.LGORT
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = p.WERKS)
LEFT JOIN esc_4_oficina dco
       ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL
      AND dco.oficina = k.VKBUR
WHERE (
    p.WERKS IN (SELECT planta FROM plantas_dbc)
    OR (
      -- Mismo alcance que `factura_totales_v1`: PAN solo cuenta si es huevo Y
      -- el combo planta+almacén+oficina está en la tarifa oficial -- sin el
      -- EXISTS, "vendido" de PAN sale 3,6x más grande (ver encabezado).
      p.WERKS = 'PANF'
      AND p.SPART = 'H'
      AND EXISTS (SELECT 1 FROM alcance_pan a
                  WHERE a.WERKS = p.WERKS AND a.LGORT = p.LGORT AND a.VKBUR = k.VKBUR)
    )
  )
  AND (p.ABGRU IS NULL OR p.ABGRU = '')    -- excluye líneas rechazadas/anuladas (sección 4.1)
  AND CAST(k.ERDAT AS DATE) >= '2026-01-01'

UNION ALL

-- Facturado ---------------------------------------------------------------
SELECT
  'facturado' AS fase,
  f.company_code AS sociedad,
  CAST(f.billing_date AS DATE) AS fecha,
  CAST(f.billing_document AS STRING) AS documento,
  f.item_number AS linea,                    -- confirmado: item_number es el número de línea real (INFORMATION_SCHEMA)
  f.sales_division AS division_code,
  ba.business_area_name AS division,
  f.distribution_channel AS canal_code,
  COALESCE(dc.cedis, dal.cedis, dma.cedis, dco.cedis) AS cedis,
  COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
  CASE WHEN dc.cedis IS NOT NULL THEN 'almacen+oficina'
       WHEN dal.cedis IS NOT NULL THEN 'solo almacen'
       WHEN dma.cedis IS NOT NULL THEN 'lista de nombres'
       WHEN dco.cedis IS NOT NULL THEN 'solo oficina'
  END AS cedis_origen,
  -- Almacén central: el cliente confirmó el 25/08/2026 que estos cuatro NO
  -- pasan por ningún CEDIS y NO generan comisión para nadie. No es que les
  -- falte el dato: es que la respuesta correcta es "ninguno". Son $832,4 M
  -- facturados ($656,5 M dentro de las cinco divisiones que DBC opera), el
  -- 66,4% de todo lo que salía sin CEDIS. Se marcan en vez de borrarse para que
  -- el total siga cuadrando y se pueda auditar cuánto se está dejando fuera.
  f.storage_location IN ('BO28', 'BO01', 'H723', 'H793') AS almacen_central,
  f.sales_office AS oficina,
  f.receiving_plant AS planta,
  f.storage_location AS almacen,
  f.material_number AS material_number,     -- confirmado: nombre real de columna (consulta de referencia del senior)
  CAST(f.invoiced_quantity AS FLOAT64) AS cantidad,
  f.sales_unit AS unidad,                   -- confirmado: unidad de invoiced_quantity (CS/PZA/PAQ/SAC/KG/... — sección 8)
  CAST(f.stockkeeping_units AS FLOAT64) AS cantidad_cajas,  -- resuelve pendiente #7: cantidad ya convertida a unidad de manejo/caja (validado V13b/V14/V15); excepción de bajo impacto en COM/CUT (ver encabezado)
  CAST(f.amount_mxn AS FLOAT64) AS monto,   -- único monto confiable para comisión (sección 4.3)
  TRUE AS monto_confiable
FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` f
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = f.sales_division
LEFT JOIN esc_1_almacen_oficina dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
LEFT JOIN esc_2_almacen dal
       ON dc.cedis IS NULL AND dal.almacen = f.storage_location
LEFT JOIN esc_3_nombre dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = f.storage_location
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = f.receiving_plant)
LEFT JOIN esc_4_oficina dco
       ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL
      AND dco.oficina = f.sales_office
-- 2026-09-10: se agrega PAN (mismo criterio que `alcance_pan`/`facturas` de
-- `v1_comision_dbc_completo_cobro.sql`) -- DBC sigue acotado por su lista de
-- plantas; PAN se acota por división Huevo + combinación con tarifa oficial,
-- NO por planta (su única planta, PANF, no está en `plantas_dbc`).
WHERE (
    (f.company_code = 'DBC' AND f.receiving_plant IN (SELECT planta FROM plantas_dbc))
    OR (f.company_code = 'PAN'
        AND f.sales_division = 'H'
        AND EXISTS (SELECT 1 FROM alcance_pan k
                    WHERE k.WERKS = f.receiving_plant
                      AND k.LGORT = f.storage_location
                      AND k.VKBUR = f.sales_office))
  )
  AND CAST(f.billing_date AS DATE) BETWEEN '2026-01-01' AND CURRENT_DATE()  -- excluye años inválidos (2201/2202 — sección 2, pendiente #4)
  -- Solo factura real (ver el comentario largo en v1_flujo_producto_dbc.sql).
  -- El 96% de las cancelaciones restaban un importe que nunca se sumó, porque
  -- SAP borra la factura al cancelarla: doble resta de $126,6 M.
  AND f.document_category = 'M'

UNION ALL

-- Cobrado / compensado ------------------------------------------------------
-- sap_bsad_cleared_items no trae CEDIS/oficina/planta/división/canal/sociedad
-- propios confiables -- se heredan de la factura vía billing_document
-- (factura_sitio_v1, extendida el 2026-09-07 y con `sociedad` desde el
-- 2026-09-10). Tampoco llega a nivel material. Sí tiene su propio
-- `BUKRS_company_code`, pero eso es la sociedad del PAGO, no necesariamente
-- la de la factura que salda (en la práctica siempre coinciden) -- por
-- consistencia con las otras dos fases, `sociedad` aquí sale de la factura,
-- igual que `division_code`/`canal_code`.
--
-- 2026-09-10: YA NO puede haber un pago sin factura cruzada -- `pago_factura_v1`
-- ahora solo trae `billing_document` que SÍ están en `factura_totales_v1`
-- (DBC completo + PAN-huevo-alcance_pan), así que el `LEFT JOIN` de
-- `factura_sitio_v1` de aquí abajo siempre encuentra su sitio.
--
-- MISMA VARA QUE LAS OTRAS DOS FASES: el pago que registra SAP lleva impuestos
-- y el `monto` de facturado es neto, así que aquí se devuelve el NETO
-- equivalente -- el neto de la factura por la proporción cobrada. Con el pagado
-- a pelo, cobrado salía un 2,8% por encima ($1.229,3 M contra $1.194,9 M) y
-- podía superar a facturado en la misma factura sin que se hubiera cobrado nada
-- de más. El dinero con impuestos no se pierde: es `monto * con_impuestos/neto`.
--
-- EL PRORRATEO, que es lo que resuelve las cajas: la proporción cobrada es
-- pagado / total de la factura con impuestos, y las cajas y el neto se
-- multiplican por ella. Si se facturan 10 cajas por $100 y se cobran $80, son
-- 8 cajas. HOY ESA PROPORCIÓN ES 1 SIEMPRE (no hay cobros parciales en estos
-- datos: los 39.967 pagos cuadran exactos con su factura), así que en la
-- práctica las cajas cobradas son las de la factura, enteras -- 49,3 millones.
-- La fórmula está escrita para el día que haya cobros parciales de verdad.
SELECT
  'cobrado' AS fase,
  f.sociedad,                               -- heredada de la factura, ver el comentario de arriba
  g.fecha,
  CAST(g.billing_document AS STRING) AS documento,
  CAST(NULL AS STRING) AS linea,
  f.sales_division AS division_code,        -- heredado de la factura (sap_bsad_cleared_items no trae división/canal propios confiables)
  ba.business_area_name AS division,
  f.distribution_channel AS canal_code,
  COALESCE(dc.cedis, dal.cedis, dma.cedis, dco.cedis) AS cedis,
  COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
  CASE WHEN dc.cedis IS NOT NULL THEN 'almacen+oficina'
       WHEN dal.cedis IS NOT NULL THEN 'solo almacen'
       WHEN dma.cedis IS NOT NULL THEN 'lista de nombres'
       WHEN dco.cedis IS NOT NULL THEN 'solo oficina'
  END AS cedis_origen,                      -- aquí planta, almacén y oficina vienen heredados de la factura. PAN (2026-09-10) SIEMPRE sale NULL en los cuatro escalones a propósito: `dm_cedis` es el catálogo de DBC y no conoce los almacenes/oficinas de PAN (H7xx / 00xx propios) -- no es un hueco por resolver, PAN de verdad no tiene CEDIS DBC
  -- Almacén central: el cliente confirmó el 25/08/2026 que estos cuatro NO
  -- pasan por ningún CEDIS y NO generan comisión para nadie. No es que les
  -- falte el dato: es que la respuesta correcta es "ninguno". Son $832,4 M
  -- facturados ($656,5 M dentro de las cinco divisiones que DBC opera), el
  -- 66,4% de todo lo que salía sin CEDIS. Se marcan en vez de borrarse para que
  -- el total siga cuadrando y se pueda auditar cuánto se está dejando fuera.
  f.storage_location IN ('BO28', 'BO01', 'H723', 'H793') AS almacen_central,
  f.sales_office AS oficina,
  f.receiving_plant AS planta,
  f.storage_location AS almacen,
  CAST(NULL AS STRING) AS material_number,
  CAST(NULL AS FLOAT64) AS cantidad,        -- la fuente de cobro no llega a nivel material (sección 4.1)
  CAST(NULL AS STRING) AS unidad,           -- por lo mismo: no hay unidad de venta que heredar
  t.cajas * SAFE_DIVIDE(g.pagado, t.con_impuestos) AS cantidad_cajas,
  COALESCE(t.neto * SAFE_DIVIDE(g.pagado, t.con_impuestos), g.pagado) AS monto,
  -- FALSE solo si la factura no aparece en `factura_totales_v1` y no se pudo
  -- pasar a neto -- desde el 2026-09-10 esto ya NO puede pasar de verdad
  -- (`pago_factura_v1` solo trae billing_document que están ahí), se deja
  -- como red de seguridad honesta en vez de asumir TRUE a ciegas.
  t.billing_document IS NOT NULL AS monto_confiable
FROM pago_factura_v1 g
LEFT JOIN factura_totales_v1 t ON t.billing_document = g.billing_document
LEFT JOIN factura_sitio_v1 f ON f.billing_document = g.billing_document
LEFT JOIN `proan-quantrue.D20_DIMENSION.dm_business_area` ba ON ba.business_area_code = f.sales_division
LEFT JOIN esc_1_almacen_oficina dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
LEFT JOIN esc_2_almacen dal
       ON dc.cedis IS NULL AND dal.almacen = f.storage_location
LEFT JOIN esc_3_nombre dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = f.storage_location
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = f.receiving_plant)
LEFT JOIN esc_4_oficina dco
       ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL
      AND dco.oficina = f.sales_office;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Resumen diario — listo para KPIs/gráficas del dashboard (evita que
--    cada consulta del frontend tenga que agregar el detalle de línea).
-- ─────────────────────────────────────────────────────────────────────────
-- `unidad` entra en el GROUP BY a propósito: `cantidad` viene en unidades
-- mixtas (CS/PZA/PAQ/SAC/KG/... — sección 8), así que sumarla sin separar por
-- unidad mezclaría cosas no comparables. `cantidad_cajas` (pendiente #7,
-- resuelto -- ver encabezado) ya SÍ es comparable/sumable entre unidades
-- (solo existe para "facturado" -- NULL en vendido/cobrado, sección 8), por
-- eso se agrega aparte con su propio SUM, fuera del GROUP BY de `unidad`.
