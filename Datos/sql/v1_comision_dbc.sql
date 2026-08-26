-- ═══════════════════════════════════════════════════════════════════════════
-- Módulo de comisión — capa de dimensiones
--
-- ORDEN DE EJECUCIÓN: después de `scripts/tablas_cliente.py --cargar` (que
-- deja los cinco diccionarios del cliente) y de `v1_flujo_producto_dbc.sql`.
-- Este fichero no toca el flujo: solo añade lo que hace falta para poner
-- precio a cada línea.
--
-- POR QUÉ EXISTE ESTE FICHERO
-- El cruce material -> SET funciona (96-99% del facturado en alcance), pero
-- SET -> tarifa se quedaba en el 20%. La causa no era que faltaran tarifas:
-- `tipo_venta` se dice de dos maneras distintas. El catálogo de SAP
-- (`dm_cedis`, que es de donde sale el del flujo) antepone "VTA EN" y abrevia
-- "medio" como "MED"; el cliente escribe la palabra suelta:
--
--     flujo (dm_cedis)   tarifas (cliente)
--     ────────────────   ─────────────────
--     VTA EN RUTA        RUTA
--     VTA EN PISO        PISO
--     MED MAYOREO        1/2 MAYOREO
--     MAYOREO            MAYOREO
--
-- Quitando `tipo_venta` del cruce, la cobertura pasaba del 20% al 87%: eso es
-- lo que confirma que el problema es de vocabulario y no de datos que falten.
--
-- LO QUE NO SE MAPEA AQUÍ, Y POR QUÉ NO
-- El flujo usa un solo vocabulario para las cinco divisiones. Las tarifas, no:
--
--     H   RUTA · PISO · 1/2 MAYOREO · MAYOREO · ABASTOS
--     BO  MAYOREO · MENUDEO
--     IA  MAYOREO · MENUDEO
--     L   RUTA
--     A   no usa tipo de venta: va por oficina y material (tabla aparte)
--
-- Botana y croqueta solo distinguen mayoreo de menudeo. Que MENUDEO cubra
-- "VTA EN RUTA + VTA EN PISO + MED MAYOREO" es plausible y **es una decisión
-- de negocio, no una deducción**: MED MAYOREO ("medio mayoreo") podría caer de
-- cualquiera de los dos lados, y en botana son $68,7 M. Lo mismo con ABASTOS
-- en huevo, con EXTRAS y con las líneas que no traen tipo de venta.
--
-- Así que esas filas entran con `equivale = FALSE`: quedan documentadas y
-- medibles, pero **no cruzan**. Preferimos un importe sin tarifa —que se ve— a
-- una tarifa inventada, que no se ve.
--
-- LO QUE ESTÁ EN JUEGO (facturado en alcance, millones de pesos):
--
--                     H      BO      IA       A       L
--     VTA EN RUTA   235,8   150,5    47,1    36,5    27,3
--     MAYOREO        72,5     6,3     9,4     2,1     1,1
--     MED MAYOREO    11,2    68,7     0,9     3,6     0,6
--     VTA EN PISO    15,1     5,5     0,4     2,2     0,1
--     (sin tipo)     12,8     8,2     1,4     0,0     2,1
--     EXTRAS          4,5     3,3     0,5     2,2     0,6
--
--     MENUDEO sin resolver = 224,7 M de botana + 48,4 M de croqueta = 273,1 M.
--     Es, con diferencia, la pregunta más cara que queda abierta.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1) dim_tipo_venta_v1 — el puente entre los dos vocabularios.
--
--    Las filas van ESCRITAS A MANO a propósito. Se podría derivar tres de las
--    cuatro quitando el prefijo "VTA EN" y normalizando, pero "MED" -> "1/2"
--    no sale de ninguna regla de texto, y una regla que acierta tres de cuatro
--    invita a confiar en ella para la quinta. Cuatro filas explícitas se leen
--    de un vistazo y se auditan sin ejecutar nada.
--
--    CÓMO SE USA — el `AND tv.equivale` no es opcional:
--
--      LEFT JOIN dim_tipo_venta_v1 tv
--             ON tv.tipo_venta_flujo = f.tipo_venta AND tv.equivale
--      LEFT JOIN DBC_dim_comision_tarifa t
--             ON t.tipo_venta = tv.tipo_venta_tarifa AND ...
--
--    OJO CON LOS NULOS: en el flujo `tipo_venta` es NULL (nunca cadena vacía)
--    en 644 grupos; en la tabla de tarifas no hay ni un NULL ni un vacío. Un
--    `=` no cruza NULL con nada, que aquí es lo correcto: esas líneas no
--    tienen tipo de venta, así que no pueden tener tarifa por esta llave.
--    Se cuentan en la verificación del final, no se esconden.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_tipo_venta_v1` AS
SELECT * FROM UNNEST([
  -- Equivalencias literales: la misma palabra escrita de otra forma.
  STRUCT('VTA EN RUTA' AS tipo_venta_flujo, 'RUTA'        AS tipo_venta_tarifa,
         TRUE AS equivale, 'misma palabra, dm_cedis antepone "VTA EN"' AS fundamento),
  STRUCT('VTA EN PISO',  'PISO',
         TRUE, 'misma palabra, dm_cedis antepone "VTA EN"'),
  STRUCT('MED MAYOREO',  '1/2 MAYOREO',
         TRUE, 'MED = medio = 1/2, el resto del rótulo es idéntico'),
  STRUCT('MAYOREO',      'MAYOREO',
         TRUE, 'idéntico en las dos fuentes'),

  -- Pendientes del cliente. Están aquí para que se puedan contar, no para que
  -- crucen: `equivale = FALSE` las deja fuera de cualquier join que respete el
  -- contrato de arriba.
  STRUCT('EXTRAS',       CAST(NULL AS STRING),
         FALSE, 'sin contrapartida en las tarifas, $11,0 M en las cinco divisiones'),
  STRUCT(CAST(NULL AS STRING), 'MENUDEO',
         FALSE, 'sin equivalencia literal a propósito: se resuelve por otra vía, ver dim_tarifa_unica_v1, confirmada por Diego el 26/08/2026'),
  STRUCT(CAST(NULL AS STRING), 'ABASTOS',
         FALSE, '8 tarifas de huevo sin uso, no hay "abastos" en dm_cedis — preguntado')
]);


-- ─────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN — no es opcional, y hay dos razones, las dos aprendidas caro.
--
-- PRIMERA: un cruce puede no ejecutarse nunca y no decir nada. El 25/08/2026
-- un escalón entero del cruce de CEDIS estuvo dos días muerto porque comparaba
-- con cadena vacía un campo que llegaba nulo. No dio error, no rompió ningún
-- test, no dejó rastro. **Un cruce que resuelve cero filas no es un dato, es
-- una alarma.**
--
-- SEGUNDA: un cruce puede resolver de más. La matriz de tarifas NO tiene una
-- fila por llave — huevo trae 194 filas para 186 llaves y botana 1.568 para
-- 949, porque las hojas duplicadas se contradicen. Un `LEFT JOIN` contra ella
-- duplica cada línea del flujo que toque una llave en conflicto, y el importe
-- sube solo. Pasó al escribir este mismo fichero: botana salía con $248,4 M
-- facturados cuando son $242,5 M, y huevo con $359,0 M cuando son $352,0 M.
-- Nada avisa; el total simplemente deja de cuadrar con silver.
--
-- Por eso esta consulta agrupa la matriz a UNA fila por llave antes de mirarla,
-- y cuenta los valores en conflicto en vez de elegir uno. La regla para todo lo
-- que venga después: **contra la matriz de tarifas no se hace LEFT JOIN hasta
-- que el conflicto esté resuelto.** Cuando el cliente diga qué hoja vale, la
-- matriz tendrá una fila por llave y el join será seguro.
-- ─────────────────────────────────────────────────────────────────────────
--
-- WITH tar AS (
--   SELECT division, oficina, `set`, tipo_venta, COUNT(DISTINCT tarifa) AS valores
--   FROM   `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa`
--   GROUP BY 1, 2, 3, 4
-- ),
-- base AS (
--   SELECT f.division_code, f.monto, m.`set` AS s, tv.tipo_venta_tarifa AS tvt,
--          (SELECT ANY_VALUE(valores) FROM tar t
--           WHERE t.division = f.division_code AND t.oficina = f.oficina
--             AND t.`set` = m.`set` AND t.tipo_venta = tv.tipo_venta_tarifa) AS valores
--   FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto` f
--   LEFT JOIN (SELECT DISTINCT material_sap, `set`
--              FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_set_material`) m
--          ON m.material_sap = f.material_number
--   LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_tipo_venta_v1` tv
--          ON tv.tipo_venta_flujo = f.tipo_venta AND tv.equivale
--   WHERE f.fase = 'facturado' AND NOT f.almacen_central
--     AND f.division_code IN ('H', 'BO', 'IA', 'A', 'L')
-- )
-- SELECT division_code AS division,
--   ROUND(SUM(monto)/1e6, 1)                                    AS facturado_mm,
--   ROUND(100*SUM(IF(s   IS NOT NULL, monto, 0))/SUM(monto), 1) AS pct_set,
--   ROUND(100*SUM(IF(tvt IS NOT NULL, monto, 0))/SUM(monto), 1) AS pct_tipo,
--   ROUND(100*SUM(IF(valores  = 1,    monto, 0))/SUM(monto), 1) AS pct_tarifa_limpia,
--   ROUND(100*SUM(IF(valores  > 1,    monto, 0))/SUM(monto), 1) AS pct_en_conflicto
-- FROM base GROUP BY division ORDER BY facturado_mm DESC;
--
-- Lo que da hoy (25/08/2026), medido. `facturado_mm` tiene que cuadrar con
-- silver sin joins: si sube, algo está multiplicando.
--
--   division  facturado_mm  pct_set  pct_tipo  pct_tarifa_limpia  pct_en_conflicto
--   H              352,0      99,3     95,1          82,5               2,0
--   BO             242,5      96,5     95,3           0,2               2,4
--   IA              59,7      97,6     96,8          12,2               0,0
--   A               46,5      98,0     95,3           0,0               0,0
--   L               31,8     100,0     91,5          79,5               0,0
--
-- Cómo se leen esas columnas:
--
--   H   el caso sano. Se puede calcular comisión sobre el 82,5% del facturado
--       ya mismo. Los 8 conflictos valen 2,0% y hay que resolverlos, pero son
--       ocho decisiones, no un bloqueo.
--   BO  0,2%. No es un fallo del cruce: `pct_tipo` es 95,3%, o sea que el tipo
--       de venta sí traduce. Lo que falta es saber qué cubre MENUDEO, y hasta
--       que se sepa botana no tiene tarifa aplicable. $242,5 M parados.
--   IA  igual que botana, pero MAYOREO sí cruza y salva el 12,2%.
--   A   0% a propósito: abarrotes no usa tipo de venta ni SET. Va por oficina y
--       material, en `DBC_dim_comision_abarrotes`, y necesita su propio motor.
--   L   `pct_set` = 100% solo desde que existe `data/mapeo_set_material.csv`.
--       Antes era 0% y sus $31,8 M no se podían comisionar.
--
-- `pct_tarifa_limpia` queda por debajo de `pct_tipo` porque la tarifa cruza
-- además por oficina, y hay oficinas del flujo sin fila en la matriz. Ese hueco
-- no se tapa con un respaldo: una tarifa de otra oficina es dinero mal
-- repartido, no un dato incompleto.

-- ─────────────────────────────────────────────────────────────────────────
-- 2) dim_tarifa_v1 — la matriz de tarifas, UNA fila por llave.
--
--    Esta vista existe para que sea IMPOSIBLE repetir el error que se cometió
--    escribiendo este fichero. La tabla del cliente no tiene una fila por
--    llave: botana trae 1.568 para 949 llaves y huevo 194 para 186, porque hay
--    hojas duplicadas que se contradicen. Un `LEFT JOIN` contra la tabla cruda
--    duplica cada línea del flujo que toque una llave repetida, y el importe
--    sube sin que nada avise: botana salía con $248,4 M facturados cuando son
--    $242,5 M.
--
--    Agrupando aquí, el join de abajo no puede multiplicar aunque quiera. Y el
--    conflicto no se resuelve eligiendo: se cuenta (`valores`) y se acota
--    (`tarifa_min`, `tarifa_max`), para que la pantalla pueda decir "esto vale
--    entre X e Y según qué hoja" en vez de dar un número inventado.
--
--    LA LLAVE es división + oficina + SET + tipo de venta. El fichero del
--    cliente trae además centro y almacén, pero vienen vacíos en botana y
--    croqueta, así que meterlos en la llave partiría filas sin ganar nada.
--
--    BOTANA (BO) es un caso aparte desde el 26/08/2026. Sus 619 casillas en
--    conflicto no son un empate entre hojas igual de válidas: son una hoja
--    vieja que Alejandro dejó oculta en el fichero ("Sheet1 ... esa fue como
--    iniciamos pero esta es la actual"). De las 949 llaves de botana, 624
--    están en las dos hojas (y 619 de esas se contradicen), 236 están solo en
--    `Sheet1` y 89 solo en `DIVISIÓN BOTANA (BO)`. Antes de agrupar, `vigente`
--    descarta `DIVISIÓN BOTANA (BO)` en toda llave donde exista la misma
--    llave en `Sheet1`, y la conserva en las 89 donde `Sheet1` no llega. El
--    resto de divisiones no tiene este problema (huevo sí duplica hoja con
--    "ayuda SMA", pero esa la sigue sin confirmar el cliente, así que no se
--    toca aquí).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_v1` AS
WITH vigente AS (
  SELECT t.*
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa` t
  WHERE t.division != 'BO'
     OR t.hoja = 'Sheet1'
     OR NOT EXISTS (
          SELECT 1 FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa` s
          WHERE s.division = t.division AND s.oficina = t.oficina
            AND s.`set` = t.`set` AND s.tipo_venta = t.tipo_venta
            AND s.hoja = 'Sheet1')
)
SELECT
  division,
  oficina,
  `set`,
  tipo_venta,
  COUNT(DISTINCT tarifa) AS valores,        -- 1 = usable · >1 = en conflicto
  MIN(tarifa)            AS tarifa_min,
  MAX(tarifa)            AS tarifa_max,
  -- Solo hay tarifa aplicable donde no hay discusión. Donde la hay, esto es
  -- NULL a propósito: que la comisión salga vacía y se vea, en vez de que
  -- salga un número que nadie puede defender.
  IF(COUNT(DISTINCT tarifa) = 1, MIN(tarifa), NULL) AS tarifa,
  STRING_AGG(DISTINCT hoja, ' | ' ORDER BY hoja)    AS hojas
FROM vigente
GROUP BY division, oficina, `set`, tipo_venta;


-- ─────────────────────────────────────────────────────────────────────────
-- 2b) dim_tarifa_unica_v1 — la única tarifa que existe para una oficina+SET.
--
--     DE DÓNDE SALE ESTA VISTA. El tipo de venta se dice de dos maneras y solo
--     cuatro rótulos se traducen palabra por palabra. Quedaban fuera MENUDEO
--     (que botana y croqueta usan sin que exista en el catálogo de SAP),
--     ABASTOS, EXTRAS y las líneas sin tipo — $273 M de facturado esperando a
--     que el cliente dijera a qué corresponde cada uno.
--
--     Resulta que no hace falta preguntarlo, porque los datos lo contestan: el
--     fichero del cliente trae, para cada oficina + SET, **solo la tarifa del
--     canal que esa combinación realmente vende**. Contado sobre el flujo:
--
--       división  tipo en el flujo   tarifas que existen ahí   combinaciones
--       BO        VTA EN RUTA        solo MENUDEO                  183
--       BO        MED MAYOREO        solo MAYOREO                  128
--       IA        VTA EN RUTA        solo MENUDEO                  136
--       H         EXTRAS             solo RUTA                       4
--       H         VTA EN PISO        solo ABASTOS                    2
--       L         MAYOREO/EXTRAS/…   solo RUTA                      48
--
--     Donde una oficina hace medio mayoreo hay tarifa de MAYOREO y CERO de
--     MENUDEO; donde hace ruta, al revés. No estamos eligiendo entre
--     alternativas: es que solo hay una. Es la misma lógica que resolvió el
--     mapeo de CEDIS, y la misma cautela — donde haya más de una y ninguna
--     case por la vía literal, la línea se queda sin comisión y se ve.
--
--     CONFIRMADO el 26/08/2026. Diego: "el primero es correcto solo aplica
--     comisión en base a su tipo de operación". Sigue siendo la deducción
--     original, no algo que el cliente nos haya dado hecho — así que
--     `tipo_venta_origen` se deja tal cual, marcando cada línea con el
--     escalón que la resolvió, por si hiciera falta aislar algo más adelante.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_unica_v1` AS
-- Lee la tabla cruda y no `dim_tarifa_v1` porque esa vista ya es una
-- agregación, y al expandirla aquí quedaría una agregación sobre otra, que
-- BigQuery no permite. Da igual: los tipos de venta distintos por oficina+SET
-- son los mismos antes y después de colapsar el conflicto de las dos hojas.
--
-- Las columnas van cualificadas con `t.` a propósito: sin el prefijo, el
-- HAVING resuelve `tipo_venta` al alias del SELECT —que es ANY_VALUE(...)— y
-- BigQuery lo rechaza por anidar agregaciones.
SELECT
  t.division,
  t.oficina,
  t.`set`,
  ANY_VALUE(t.tipo_venta) AS tipo_venta   -- solo hay uno: lo garantiza el HAVING
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_comision_tarifa` t
GROUP BY t.division, t.oficina, t.`set`
HAVING COUNT(DISTINCT t.tipo_venta) = 1;


-- ─────────────────────────────────────────────────────────────────────────
-- 3) dim_base_comision_v1 — sobre qué se multiplica la tarifa, por división.
--
--    Esto vive en una tabla y no en un `IF` dentro de la vista porque no es
--    una regla técnica: es una regla de negocio, distinta en cada división, y
--    hoy solo UNA está confirmada por el cliente. Enterrada en un `CASE` habría
--    que leer SQL para saber qué se está suponiendo; aquí se ve de un vistazo
--    qué sabemos y qué estamos deduciendo, y cambiarlo es editar una fila.
--
--    CÓMO SE DECIDE, cuando no lo dice el cliente: se calcula la comisión con
--    las dos bases y se mira cuál da una tasa que existe en distribución. Con
--    huevo fue concluyente —0,21% por caja contra 3,91% por kilo— y acertó.
--
--                  kg/caja   si por caja   si por kilo
--        huevo       18,36        0,21%        3,91%   <- kilo, y confirmado
--        botana       0,06        8,59%        0,53%   <- caja, sin duda
--        croqueta     6,09        1,22%        7,31%   <- DUDOSO, ver abajo
--        leche         n/a        6,33%          n/a   <- pieza
--
--    CROQUETA: confirmado por Alejandro el 26/08/2026 ("Es por Kilogramo"),
--    contestando al punto 2 del correo. La aritmética ya lo decía con la misma
--    claridad que en huevo —por caja sale al 1,22%, que no existe en
--    distribución, y por kilo al 7,31%, en línea con botana— pero se dejó en
--    `caja` hasta tener la confirmación: deducir bien no es lo mismo que
--    saber, y ya nos pasó con "CEDIS SAN JUAN", que se llamaba CEDIS y no lo
--    era.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_base_comision_v1` AS
SELECT * FROM UNNEST([
  STRUCT('H'  AS division_code, 'kg'   AS base, TRUE  AS confirmada,
         'el cliente lo dijo el 25/08/2026: "para los demás materiales es por kg". Por caja daría 0,21% del facturado y por kilo 3,91%' AS fundamento),
  STRUCT('BO', 'caja', FALSE,
         'aritmética concluyente: 8,59% por paquete contra 0,53% por kilo. El paquete pesa 60 g'),
  STRUCT('L',  'caja', FALSE,
         'aritmética: 6,33% por pieza. El cartón de leche se vende por pieza, no al peso'),
  STRUCT('IA', 'kg', TRUE,
         'el cliente lo confirmó el 26/08/2026: "Es por Kilogramo". Por caja daba 1,22% del facturado, que no existe en distribución; por kilo, 7,31%, en línea con botana'),
  STRUCT('A',  CAST(NULL AS STRING), FALSE,
         'abarrotes no usa ni SET ni tipo de venta: va por margen sobre el precio de cada material, en DBC_dim_comision_abarrotes. Necesita su propio motor')
]);


-- ─────────────────────────────────────────────────────────────────────────
-- 4) v1_comision_linea — una fila por línea facturada, con su comisión.
--
--    POR QUÉ SOBRE FACTURADO Y NO SOBRE COBRADO, que es lo que dice el manual
--    que se paga. Por dos razones, y las dos hay que tener presentes:
--
--    a) Cobrado no tiene material. `sap_pago` da una fila por factura, sin
--       nivel de línea, así que no hay SET y por tanto no hay tarifa. La
--       comisión SOLO se puede calcular donde hay material, y eso es facturado.
--
--    b) `sap_pago` no ve todos los cobros. Solo el 27% del importe facturado
--       tiene un pago registrado, y el ratio es PLANO en los ocho meses de
--       2026 (enero 29,7%, agosto 26,3%). Si fuera retraso de cobro, enero
--       estaría muy por encima. No lo está: la fuente está incompleta.
--       Correlaciona algo con el tipo de venta —crédito 41-49%, ruta 20%—,
--       lo que encaja con que la venta en ruta se cobre en efectivo, pero ni
--       el mayoreo llega a la mitad, así que no lo explica del todo.
--
--    Así que esta vista calcula la comisión DEVENGADA (sobre lo facturado) y
--    marca aparte qué parte tiene cobro registrado (`factura_cobrada`). Cuando
--    el cliente aclare la cobertura de `sap_pago`, la comisión pagable es
--    filtrar por esa columna: no hay que rehacer nada.
--
--    LA BASE DE CÁLCULO no se decide aquí: sale de `dim_base_comision_v1`,
--    que es donde está documentada división por división y con su fundamento.
--
--    OJO CON EL PESO DE LECHE: 265 líneas traen `net_weight` absurdo, hasta
--    39.690 toneladas en una sola línea, y la suma sale negativa. No estorba
--    porque leche va por pieza, pero nadie debe usar esa columna para leche
--    sin limpiarla antes.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_comision_linea` AS
WITH peso AS (
  -- Solo tres columnas: BigQuery poda el resto y esto cuesta 0,09 GiB en vez
  -- de los 59 GiB que ocupa la tabla entera.
  SELECT
    CAST(billing_document AS STRING) AS documento,
    item_number                      AS linea,
    net_weight                       AS peso_neto
  FROM `proan-quantrue.D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item`
  WHERE company_code = 'DBC'
    AND CAST(billing_date AS DATE) BETWEEN '2026-01-01' AND CURRENT_DATE()
),
set_material AS (
  -- DISTINCT y no la tabla cruda: un material puede venir repetido con dos
  -- descripciones. Hoy ningún material está en dos SETs (el extractor lo
  -- comprueba y avisa), así que esto no puede multiplicar.
  SELECT DISTINCT material_sap, `set`
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_set_material`
),
cobradas AS (
  SELECT DISTINCT documento
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto`
  WHERE fase = 'cobrado'
),
base AS (
  SELECT
    f.fecha, f.documento, f.linea,
    f.division_code, f.division, f.cedis, f.tipo_venta, f.oficina, f.almacen,
    f.material_number, f.unidad,
    f.cantidad_cajas, f.monto,
    w.peso_neto,
    m.`set`,
    tv.tipo_venta_tarifa,
    bc.base AS base_unidad,
    c.documento IS NOT NULL AS factura_cobrada,
    tu.tipo_venta AS tipo_venta_unica
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto` f
  LEFT JOIN peso w          ON w.documento = f.documento AND w.linea = f.linea
  LEFT JOIN set_material m  ON m.material_sap = f.material_number
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_tipo_venta_v1` tv
         ON tv.tipo_venta_flujo = f.tipo_venta AND tv.equivale
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_unica_v1` tu
         ON tu.division = f.division_code AND tu.oficina = f.oficina
        AND tu.`set` = m.`set`
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_base_comision_v1` bc
         ON bc.division_code = f.division_code
  LEFT JOIN cobradas c      ON c.documento = f.documento
  WHERE f.fase = 'facturado'
    AND NOT f.almacen_central
    AND f.division_code IN ('H', 'BO', 'IA', 'A', 'L')
),
-- El tipo de venta efectivo, en dos escalones. El literal manda: si esa
-- oficina+SET tiene la tarifa del canal traducido palabra por palabra, se usa
-- esa y no se mira nada más. El segundo escalón solo entra donde el primero
-- falla, igual que la cadena de CEDIS.
efectivo AS (
  SELECT b.*,
    CASE
      WHEN lit.tarifa IS NOT NULL OR lit.valores IS NOT NULL THEN b.tipo_venta_tarifa
      ELSE b.tipo_venta_unica
    END AS tipo_venta_efectivo,
    CASE
      WHEN lit.valores IS NOT NULL         THEN 'equivalencia literal'
      WHEN b.tipo_venta_unica IS NOT NULL  THEN 'única tarifa de la oficina'
    END AS tipo_venta_origen,
    -- Distingue "esta oficina no está en la matriz de tarifas" de "está, pero
    -- vende por varios canales y no sabemos cuál es esta línea". Son dos
    -- problemas distintos y se resuelven preguntando cosas distintas.
    EXISTS(SELECT 1 FROM `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_v1` a
           WHERE a.division = b.division_code AND a.oficina = b.oficina
             AND a.`set` = b.`set`) AS hay_alguna_tarifa
  FROM base b
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_v1` lit
         ON lit.division   = b.division_code
        AND lit.oficina    = b.oficina
        AND lit.`set`      = b.`set`
        AND lit.tipo_venta = b.tipo_venta_tarifa
),
con_tarifa AS (
  SELECT e.*, t.valores, t.tarifa, t.tarifa_min, t.tarifa_max, t.hojas
  FROM efectivo e
  LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_tarifa_v1` t
         ON t.division    = e.division_code
        AND t.oficina     = e.oficina
        AND t.`set`       = e.`set`
        AND t.tipo_venta  = e.tipo_venta_efectivo
)
SELECT
  fecha, documento, linea,
  division_code, division, cedis, oficina, almacen,
  material_number, `set`,
  tipo_venta,                      -- vocabulario del flujo (dm_cedis)
  tipo_venta_tarifa,               -- su traducción literal, si la tiene
  tipo_venta_efectivo,             -- el que se acabó usando para buscar tarifa
  tipo_venta_origen,               -- qué escalón lo resolvió · NULL = ninguno
  unidad, cantidad_cajas, peso_neto, monto, factura_cobrada,

  -- La base de cálculo y su unidad, juntas: leer una sin la otra es cómo se
  -- suman kilos con cajas.
  base_unidad,
  CASE base_unidad WHEN 'kg' THEN peso_neto WHEN 'caja' THEN cantidad_cajas END AS cantidad_base,

  valores, tarifa, tarifa_min, tarifa_max, hojas,

  -- La comisión, solo donde se puede defender.
  tarifa * CASE base_unidad WHEN 'kg' THEN peso_neto WHEN 'caja' THEN cantidad_cajas END AS comision,
  -- La horquilla, para las llaves en conflicto: acota lo que está en juego
  -- sin fingir que se sabe el número.
  IF(valores > 1, tarifa_min * CASE base_unidad WHEN 'kg' THEN peso_neto
                                                 WHEN 'caja' THEN cantidad_cajas END, NULL) AS comision_min,
  IF(valores > 1, tarifa_max * CASE base_unidad WHEN 'kg' THEN peso_neto
                                                 WHEN 'caja' THEN cantidad_cajas END, NULL) AS comision_max,

  -- POR QUÉ no hay comisión, cuando no la hay. El orden importa: se devuelve
  -- el primer obstáculo, que es el que hay que quitar. Sin esta columna, un
  -- total bajo no se distingue de un total correcto.
  CASE
    -- EL ORDEN DE ESTE CASE ES EL DIAGNÓSTICO, y ponerlo mal no da error: da
    -- una etiqueta plausible que manda a mirar donde no es. Pasó — la rama de
    -- "varias tarifas posibles" estaba antes que las dos de abajo y se tragaba
    -- $41,8 M que en realidad eran la oficina 0001 y oficinas que no están en
    -- la matriz. La regla: de la causa más concreta a la más genérica.
    WHEN division_code = 'A'          THEN 'abarrotes: modelo aparte, sin motor'
    WHEN `set` IS NULL                THEN 'material sin SET'
    -- La 0001 no es una oficina: es el destino por defecto del catálogo. Ya se
    -- topó con ella el mapeo de CEDIS —una fila en dm_cedis, 70 almacenes en el
    -- flujo, y sin filtrarla le habría regalado $418 M a "Mexico 1"—. Aquí sale
    -- otra vez: $31,9 M en 168 líneas de $190.000 y 430 cajas de media, que no
    -- son ventas de ruta. No le falta la tarifa: no tiene a quién comisionar.
    WHEN oficina = '0001'             THEN 'oficina 0001: cajón de sastre, sin comisionista'
    WHEN NOT hay_alguna_tarifa        THEN 'esa oficina no tiene tarifa para ese SET'
    -- Llegados aquí la oficina SÍ está en la matriz, así que el problema es de
    -- canal: no sabemos por cuál se vendió esta línea. Y las dos razones de que
    -- no lo sepamos se arreglan de forma distinta.
    --
    -- La primera es nuestra: el CEDIS de estas líneas se resolvió por los
    -- escalones 2 o 3 de la cadena (`solo almacen` y `lista de nombres`), y
    -- ninguno de los dos aporta tipo de venta —un almacén sirve varios canales
    -- según la oficina—. El 100% de las líneas sin tipo viene de ahí.
    --
    -- HOY ESTA RAMA SALE VACÍA, y conviene saber por qué antes de borrarla:
    -- de las 196 líneas sin tipo cuya oficina sí está en la matriz, todas
    -- tienen un solo canal tarifado, así que el segundo escalón las resuelve y
    -- acaban en 'calculada'. Se queda como red: el día que una de esas oficinas
    -- tarife dos canales, esas líneas tienen que salir a la luz y no colarse.
    WHEN tipo_venta_efectivo IS NULL AND tipo_venta IS NULL
                                      THEN 'sin tipo de venta: su CEDIS se dedujo sin él'
    WHEN tipo_venta_efectivo IS NULL  THEN 'varias tarifas posibles y ninguna equivale'
    WHEN valores > 1                  THEN 'tarifa en conflicto entre hojas'
    WHEN base_unidad = 'kg' AND (peso_neto IS NULL OR peso_neto = 0)
                                      THEN 'sin peso: no hay base de cálculo'
    ELSE 'calculada'
  END AS comision_estado,

  -- Aparte del estado, y no dentro, a propósito. `comision_estado` contesta
  -- "por qué NO hay comisión"; estas líneas SÍ la tienen. Si fueran un estado
  -- más, partirían el total de 'calculada' en dos y quien sumara por ese
  -- estado se dejaría fuera $96.658 sin enterarse.
  --
  -- Son 12.434 líneas con cantidad entregada e importe cero, casi todas de
  -- leche (11.400; botana 1.032 y croqueta 2). De ellas llegan a calcularse
  -- 10.435 y suman $101.824 de comisión — las de botana no, porque su tipo de
  -- venta está pendiente. Se comisionan (hay producto entregado) pero quedan
  -- marcadas para poder aislarlas el día que alguien pregunte, o si el cliente
  -- dice que no.
  IF(monto = 0, 'línea sin importe', NULL) AS nota
FROM con_tarifa;
