-- =============================================================================
-- Comisiones DBC+PAN — v1: flujo de producto (vendido, facturado, cobrado)
-- =============================================================================
-- Proyecto BigQuery: proan-quantrue (región us-west4).
-- Basado en Datos/Comisiones_DBC_Borrador_Tecnico.md, secciones 2, 3, 4, 9 y 11.
--
-- QUÉ SÍ incluye v1 (las 3 capas ya resueltas y validadas — sección 4):
--   - Vendido    (sap_VBAK + sap_VBAP) -- SOLO DBC, ver sección 2 más abajo
--   - Facturado  (sap_2lis_13_vditm_billing_document_item) -- DBC + PAN (huevo, alcance_pan)
--   - Cobrado    (sap_bsad_cleared_items desde el 2026-09-07, antes sap_pago;
--                 UN RENGLÓN POR FACTURA, heredando CEDIS/oficina/división/canal/
--                 sociedad de la factura vía billing_document porque la fuente de
--                 cobro no trae esos campos — sección 4.1. Ver el comentario de
--                 `pago_factura_v1` para el porqué del `GROUP BY` y el historial
--                 de `sap_pago`)
--
-- 2026-09-10: SE AGREGA PAN a facturado/cobrado, a pedido de Silvana, para que
-- esta vista deje de contradecir a Comisiones (que ya sumaba DBC+PAN desde el
-- 2026-09-08). Ver la sección 2 (más abajo, CTE `alcance_pan`) para el criterio
-- exacto -- es el MISMO que `v1_comision_dbc_completo_cobro.sql`, no uno nuevo.
-- "Vendido" se queda solo-DBC (VBAP/VBAK no traen sociedad, ver esa sección).
--
-- QUÉ NO incluye v1 (a propósito, para no mezclar cifras sin validar con las
-- que sí lo están):
--   - Traspasos (candidata: sap_mseg). Sección 4.0 / pendiente #8: falta
--     validar que reproduce los totales de MB51. Cuando se valide, se añade
--     como cuarta rama del UNION ALL de abajo (mismo patrón).
--   - SET de producto (marca/línea): sin el export de GS03 no existe el
--     mapeo material_number → SET (sección 5). v1 expone material_number
--     (MATNR), que ya es más granular que el SET — sirve para el dashboard
--     ("detalle a tipo de producto"), NO para calcular comisión.
--
-- Grano de `v1_flujo_producto_dbc`: un renglón por evento (línea de pedido /
-- línea de factura / pago), con columna `fase` para distinguir. Debajo se
-- añade `v1_flujo_producto_dbc_resumen_diario`, agregada por
-- fecha × división × CEDIS × tipo_venta × fase, lista para KPIs/gráficas.
--
-- Todo lo que este script CREA (dim_cedis_v1, v1_flujo_producto_dbc,
-- v1_flujo_producto_dbc_resumen_diario) vive en `ZZ_PRUEBAS` mientras dure
-- esta fase de pruebas -- es el dataset destinado a eso. Cuando se valide,
-- se migra "en limpio" al dataset que corresponda (los origen -- dm_cedis,
-- dm_business_area, sap_* -- se siguen leyendo de donde ya viven).
--
-- Filtro de sociedad: `company_code` (`sap_2lis_13_vditm_billing_document_item`,
-- confirmado como campo real por la consulta de referencia del senior) y
-- `BUKRS_company_code` (`sap_bsad_cleared_items`, verificado 2026-09-07) son el
-- filtro maestro de facturado/cobrado -- DBC entra completo, PAN solo por
-- `alcance_pan` (sección 2). En sap_VBAK/VBAP NO existe ese campo (lo más
-- parecido es `BUKRS_VF` en VBAK, semántica sin confirmar, no se usó), así que
-- "vendido" sigue dependiendo de la lista de plantas de la sección 2 (solo
-- DBC) -- lista ya corregida contra datos reales (V3): faltaban H7DU y H7TX.
--
-- Confirmado por consulta de referencia del senior + INFORMATION_SCHEMA
-- (facturado, 64 columnas): `material_number`, `sales_unit` (unidad de
-- `invoiced_quantity`) e `item_number` (número de línea) son nombres reales
-- de columna.
--
-- Pendiente #7 (sección 9, conversión a caja/CJ) -- RESUELTO. `sales_unit`
-- viene en unidades mixtas (CS/PZA/PAQ/SAC/KG/...), pero `stockkeeping_units`
-- (también en facturado) ya trae la cantidad convertida a unidad de manejo
-- (caja), validado con datos reales (V13b/V14/V15 de v1_verificaciones.sql):
-- factor invoiced_quantity/stockkeeping_units constante por material a
-- través de miles de filas (ej. ~18.00 para material 000000000000012011 en
-- KG; factor 1.0 exacto para la mayoría de PAQ/SAC/PZA), sin NULLs ni ceros
-- en ninguna unidad. Única excepción de bajo impacto: unidad `COM` (213
-- filas, 0.20% del monto facturado) y un puñado de materiales `CUT`/`KG` de
-- muestra chica muestran el factor inconsistente -- se dejan como están
-- (no se descartan ni se corrigen), el impacto es marginal. `denominator_conversion_sku`
-- quedó descartado como candidato (V13/V13b): es 1 fijo en PAQ/PZA y sin
-- relación consistente en KG.
--
-- `cantidad_cajas` YA EXISTE EN LAS TRES FASES (antes solo en facturado):
--   - facturado: `stockkeeping_units`, como siempre.
--   - vendido: `KWMENG * UMVKZ/UMVKN`. VBAP sí trae el factor de conversión de
--     unidad de venta a unidad base, informado en el 100% de las líneas y
--     coincidente con `KLMENG` al cuarto decimal. El campo estaba, no se había
--     buscado.
--   - cobrado: prorrateando las cajas de la factura por la proporción cobrada
--     (pagado / total con impuestos). Hoy esa proporción es 1 en el 100% de los
--     casos, así que son las cajas de la factura enteras.
--
-- QUÉ MIDE DE VERDAD, y conviene no olvidarlo: la cantidad en la UNIDAD BASE
-- del material, que no siempre es una caja -- en vendido son PAQ en 782k
-- líneas, CS en 413k, PZA en 327k y SAC en 118k. El nombre `cantidad_cajas` se
-- mantiene porque es lo que ya consume el dashboard, pero lo comparable es que
-- las tres fases miden ahora exactamente lo mismo, no que sean cajas.
--
-- Confirmado vía INFORMATION_SCHEMA de sap_VBAK/sap_VBAP (ya no son TODO):
-- `dm_business_area` usa `business_area_code`/`business_area_name`, no
-- `sales_division`. `VKBUR` (oficina) y `VTWEG` (canal) SOLO existen en la
-- cabecera VBAK, no en el ítem VBAP -- se corrigió el alias (`k.` en vez de
-- `p.`) en la rama "vendido". `VRKME` es la unidad de venta real en VBAP.
--
-- FALLBACK DEL CRUCE DE CEDIS (sección 1b, añadido después de medir el hueco
-- sobre la tabla silver): el join a `dim_cedis_v1` es por almacén + oficina, y
-- cuando ese par no existe en dm_cedis la línea se quedaba sin CEDIS y sin tipo
-- de venta -- 118.313 líneas y $1.384 M. Ahora, y solo en ese caso, se cruza
-- por oficina sola contra `dim_cedis_oficina_v1`, que excluye a propósito las
-- oficinas cajón de sastre (ver el porqué en la sección 1b: sin ese filtro el
-- fallback le regalaba $418 M a "Mexico 1"). Recupera $79 M en facturado
-- (65,3% -> 61,4% del importe sin CEDIS), no el hueco entero: lo que queda no
-- está en dm_cedis por ninguna llave y necesita una decisión de negocio.
-- La columna nueva `cedis_origen` dice de dónde salió cada asignación, así que
-- el resultado anterior se reproduce exacto con
-- IF(cedis_origen='solo oficina', NULL, cedis) -- el fallback no borra el dato
-- viejo, lo etiqueta.
--
-- Dos incógnitas de negocio quedaron confirmadas como reales con datos (no
-- son bugs, son casos genuinos sin regla definida todavía -- ver sección
-- 15.2 del borrador): 36 combinaciones almacén+oficina de dm_cedis mapean a
-- dos sectores distintos ("Huevo (H) y Croqueta (IA)" vs. "Tortilla (A)"),
-- y sí existen facturas repartidas entre 2 almacenes. Ambas siguen resueltas
-- aquí con una regla de desempate PROVISIONAL (ver los comentarios de
-- `dim_cedis_v1` y `factura_sitio_v1` más abajo).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Dimensión CEDIS deduplicada.
--    Borrador técnico, sección 9, pendiente #1. Ya medido (V2 de
--    v1_verificaciones.sql): de 187 combinaciones almacén+oficina con más
--    de una fila en dm_cedis, 151 son duplicados inofensivos (mismo sector
--    repetido) y 36 SÍ son un conflicto real -- siempre entre los mismos dos
--    sectores: "Huevo (H) y Croqueta (IA)" vs. "Tortilla (A)". Parecen
--    almacenes/oficinas compartidos entre esas divisiones. Regla de
--    desempate aquí sigue siendo PROVISIONAL (primer sector en orden
--    alfabético -> hoy siempre cae en "Huevo (H) y Croqueta (IA)") —
--    ajustar en cuanto el negocio confirme cómo repartir esos 36 casos.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` AS
SELECT * EXCEPT (rn)
FROM (
  SELECT
    almacen,
    oficina,
    cedis,
    sector,
    tipo_venta,
    ROW_NUMBER() OVER (PARTITION BY almacen, oficina ORDER BY sector) AS rn
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
)
WHERE rn = 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 1b) Dimensión CEDIS a nivel OFICINA — el fallback del cruce.
--     El join de las tres ramas de abajo es por almacén + oficina, y cuando
--     ese par no existe en dm_cedis la línea se queda sin CEDIS y sin tipo de
--     venta. Medido sobre la silver: son 118.313 líneas y $1.384 M de importe
--     (68% del importe de vendido, 65% de facturado, 83% de cobrado — el
--     hueco es de dinero, no de líneas: las líneas sin CEDIS valen 25 veces
--     más que las que cruzan).
--
--     La oficina sola resuelve parte de eso y casi no es ambigua: de las 105
--     oficinas de dm_cedis, 103 apuntan a un único CEDIS y a un único tipo de
--     venta. Las dos que no (0122 Celaya, 0131 Tuxtla) HOY no llegan nunca al
--     fallback: sus 77.539 líneas cruzan enteras por almacén + oficina. Así
--     que el desempate de aquí no afecta a ningún dato real todavía; se define
--     igual para que mañana no dependa del azar.
--
--     REGLA DE DESEMPATE (PROVISIONAL, como la de dim_cedis_v1): gana la
--     combinación con más filas en dm_cedis, y si empatan, la primera por
--     orden alfabético para que la vista sea estable entre corridas. Hoy:
--     0122 -> Celaya Agustin / EXTRAS (24 filas contra 12) y
--     0131 -> Tuxtla 2 / MED MAYOREO (32 contra 2).
--
--     SE EXCLUYEN LAS OFICINAS CAJÓN DE SASTRE, y esto no es un detalle: es la
--     diferencia entre un fallback defendible y uno que miente. La oficina
--     `0001` tiene UNA sola fila en dm_cedis (un almacén, CEDIS "Mexico 1")
--     pero aparece con 70 almacenes distintos en el flujo. Sin filtro, el
--     fallback le mandaba $418 M a Mexico 1 apoyado en esa única fila — y los
--     nombres de esos almacenes en el maestro de SAP (T001L) dicen otra cosa:
--     `DG01`/`DG06`/`DG03` son SPART = 'DG' (Derivados de Ganado, $199 M),
--     `H723` está en planta H7AG con nombre "ALM. CENTRAL" ($171 M), y luego
--     "CANCÚN FS", "VALLARTA FS", "GUADALAJARA FS", "DIS. IZTAPALAPA",
--     "DIS. PUEBLA 2" — varios son CEDIS del catálogo distintos de Mexico 1.
--     `0001` no es una oficina, es "sin oficina". El filtro `> 1 almacén`
--     la descarta junto con `0018` (misma forma, mismo CEDIS).
--
--     LO QUE ESTO RECUPERA, medido: $79 M de facturado (65,3% -> 61,4% del
--     importe sin CEDIS), $65 M de vendido y $30 M de cobrado. Modesto a
--     propósito. Donde el nombre del almacén en T001L es legible, confirma la
--     asignación en el 89% del importe.
--
--     LO QUE NO ARREGLA NI PUEDE: los almacenes del hueco que queda no están
--     en dm_cedis POR NINGUNA LLAVE. Comprobado por tres vías distintas —
--     por par almacén+oficina, por almacén solo ($15,7 M, 1,2% del hueco), y
--     aprendiendo el mapeo nombre-de-almacén -> CEDIS de las propias líneas
--     que sí cruzan y aplicándolo al resto (otra vez $15,7 M: los nombres del
--     hueco no aparecen en ninguna línea mapeada). T001L tampoco tiene una
--     columna que sirva: solo LGOBE viene informado (99,9% del importe),
--     SPART/VKORG/VTWEG/KUNNR llegan al 9,8% y VSTEL/PARLG/LIFNR están
--     vacías. Y los sitios que nombra —San Juan, Monterrey, Mérida, Cancún,
--     Vuala, Derivados de Ganado— no existen entre los 32 CEDIS del catálogo.
--     Esto se cierra con una decisión de negocio, no con más SQL: 27 pares
--     planta+almacén+oficina de >= $3 M explican el 97% del hueco restante.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` AS
WITH oficinas_utiles AS (
  -- Más de un almacén en el catálogo = la oficina significa un sitio, no es
  -- el cajón donde cae lo que no tiene oficina propia.
  SELECT oficina
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
  GROUP BY oficina
  HAVING COUNT(DISTINCT almacen) > 1
)
SELECT * EXCEPT (filas, rn)
FROM (
  SELECT
    oficina,
    cedis,
    tipo_venta,
    COUNT(*) AS filas,
    ROW_NUMBER() OVER (
      PARTITION BY oficina
      ORDER BY COUNT(*) DESC, cedis, tipo_venta
    ) AS rn
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
  WHERE oficina IN (SELECT oficina FROM oficinas_utiles)
  GROUP BY oficina, cedis, tipo_venta
)
WHERE rn = 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 1c) Dimensión CEDIS a nivel ALMACÉN — el segundo escalón del cruce.
--     No es información nueva: es el MISMO dm_cedis mirado con una llave más
--     corta. Si un almacén aparece varias veces en el catálogo y todas dicen el
--     mismo CEDIS, el catálogo está afirmando "este almacén es ese CEDIS", y esa
--     afirmación vale también para las oficinas que no tenga listadas.
--
--     Ejemplo real: `H781` sale tres veces en dm_cedis —oficinas 0174, 0175 y
--     0176— y las tres dicen Mexico 2. Nuestro flujo lo factura además por la
--     oficina 0001, que el catálogo no lista, así que $8,7 M se caían. Con este
--     paso se colocan donde el propio catálogo dice.
--
--     SOLO ALMACENES INEQUÍVOCOS (54 de 59): los 5 que apuntan a dos CEDIS
--     quedan fuera, porque ahí habría que elegir y elegir no es deducir.
--
--     POR QUÉ ESTE PASO Y NO EL DE LA OFICINA para estos casos: la mayoría de
--     lo que rescata venía cayendo por la oficina 0001, que es un cajón de
--     sastre y los mandaba a "Mexico 1". Por almacén van a su sitio, y los
--     nombres del maestro de SAP lo confirman uno a uno: `H733` "DIS.
--     IZTAPALAPA" -> Iztapalapa, `H730` "DIS. PUEBLA 2" -> Puebla 2, `H781`
--     "ALM. CDMX 2" -> Mexico 2. Rescata ~$15 M.
--
--     No da `tipo_venta`: un mismo almacén sirve varios tipos según la oficina,
--     así que eso se sigue resolviendo por el par o por la oficina.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` AS
SELECT almacen, ANY_VALUE(cedis) AS cedis
FROM (
  SELECT almacen, cedis
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
  GROUP BY almacen, cedis
)
GROUP BY almacen
HAVING COUNT(*) = 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 1d) EL MAPEO MANUAL NO ESTÁ AQUÍ, y conviene saber dónde está.
--
--     Vive en `ZZ_PRUEBAS.DBC_dim_almacen_nombre`, en las filas con
--     `origen = 'deducido'`. Esa tabla la carga `scripts/tablas_cliente.py`
--     desde los Excel del cliente (59 filas de una lista suelta almacén ->
--     nombre de CEDIS que mandó el 24/08/2026) más las nuestras, que salen de
--     `data/mapeo_manual.csv`, versionado en el repo. La columna `origen`
--     distingue "cliente" de "deducido"; el `fundamento` dice por qué.
--
--     Hoy la parte nuestra es UNA fila: `H793` en la planta `DBC3` factura
--     $241,7 M y no está en dm_cedis por ninguna llave ni en las trece tablas
--     del cliente. Lo único que se sabe de él es que en el maestro de almacenes
--     de SAP se llama "CEDIS SAN JUAN".
--
--     LA PLANTA ES PARTE DE LA LLAVE, no un adorno: el mismo `H793` en la
--     planta `H7AG` se llama "MT AGUASCALIENTE" y es otro sitio.
--
--     SE USAN TODAS LAS FILAS, las del cliente y las nuestras. Lo que hay que
--     resolver no es cuáles valen, es que el cliente escribe los nombres a su
--     manera: "LEÓN 1" donde el catálogo pone "Leon 1", "QUERETARO" donde pone
--     "Queretaro". Sin normalizar, el mismo CEDIS saldría dos veces en la
--     pantalla con dos grafías, que es peor que no cruzarlo.
--
--     Lo hace `dim_cedis_nombre_v1`, justo debajo: normaliza (sin acentos, sin
--     espacios, mayúsculas) y **adopta la grafía del catálogo cuando el nombre
--     existe allí** — 42 de las 59. Las 17 que no existen se quedan con el
--     nombre del cliente, porque son CEDIS de verdad que el catálogo no tiene:
--     TOLUCA, CHIHUAHUA, TUXTLA 1, GUADALAJARA... y San Juan, que es el nuestro.
--     Descartarlos sería tirar información por no estar en una tabla
--     incompleta.
--
--     Lo que NO entra: `BO28`, `BO01` y `H723` ($569,6 M facturado). En SAP se
--     llaman "ALM. CENTRAL 2", "ALM. CENT. VUALA" y "ALM. CENTRAL", que no dicen
--     ninguna ciudad, y no están en ninguna lista. Inventarles un CEDIS es
--     justo lo que esto evita — y el cliente confirmó el 25/08/2026 que hacen
--     bien en no tenerlo: son almacenes centrales.
--
--     LO QUE ESTE ESCALÓN APORTA DE VERDAD: cuatro almacenes que solo existen
--     en la lista del cliente (`BO29`, `BO30`, `BO43`, `H770`), de los cuales
--     hoy solo uno factura: `BO43` -> "MEXICO CARLOS", división Botana,
--     $7,4 M en 2.693 líneas. Es la mayor parte del hueco que quedaba.
--
--     ORDEN DE EJECUCIÓN: por esto, `scripts/tablas_cliente.py --cargar` tiene
--     que haber corrido antes que este script. Si esa tabla no existe, las
--     vistas de abajo no se pueden crear.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.dim_cedis_nombre_v1` AS
WITH catalogo AS (
  SELECT DISTINCT
    cedis,
    UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(cedis, NFKD), r'[^a-z0-9]', '')) AS clave
  FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
),
lista AS (
  SELECT
    planta, almacen, nombre_cedis, origen,
    UPPER(REGEXP_REPLACE(NORMALIZE_AND_CASEFOLD(nombre_cedis, NFKD), r'[^a-z0-9]', '')) AS clave
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_almacen_nombre`
  WHERE nombre_cedis IS NOT NULL AND nombre_cedis != ''
)
SELECT * EXCEPT (rn) FROM (
  SELECT
    -- El fichero del cliente no trae columna de planta, así que esto llega
    -- NULL en las 59 filas. Se normaliza a cadena vacía porque el contrato de
    -- esta vista es "planta vacía = vale para cualquier planta", y `NULL = ''`
    -- en SQL no es FALSE sino NULL: dejarlo nulo hacía que el JOIN de abajo no
    -- cruzara NUNCA, y este escalón entero no llegaba a ejecutarse.
    IFNULL(l.planta, '') AS planta,
    l.almacen,
    l.origen,
    -- La grafía del catálogo si el nombre existe allí; si no, la del cliente.
    COALESCE(c.cedis, l.nombre_cedis) AS cedis,
    c.cedis IS NOT NULL AS grafia_del_catalogo,
    -- Una sola fila por almacén, para que este join no pueda multiplicar
    -- líneas del flujo. Si algún día hay dos, gana la nuestra.
    ROW_NUMBER() OVER (
      PARTITION BY l.almacen
      ORDER BY IF(l.origen = 'deducido', 0, 1), l.planta DESC, l.nombre_cedis
    ) AS rn
  FROM lista l
  LEFT JOIN catalogo c ON c.clave = l.clave
)
WHERE rn = 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) v1: flujo de producto DBC+PAN — vendido + facturado + cobrado, un
--    renglón por evento. `plantas_dbc` (21 plantas, sección 2) es el filtro
--    para "vendido" -- "facturado" y "cobrado" ya filtran directo por su
--    propio `company_code`.
--
-- 2026-09-10: SE AGREGA PAN (solo huevo), a pedido de Silvana, porque
-- Comisiones ya suma DBC+PAN ($2,832.8 M) y esta vista se había quedado en
-- solo-DBC ($770.7 M) -- las dos pantallas mostraban totales que parecían
-- contradecirse sin serlo (ver conversación 2026-09-10). MISMO CRITERIO que
-- `alcance_pan` de `v1_comision_dbc_completo_cobro.sql`, reutilizado tal
-- cual, no reinventado: PAN entra SOLO en división Huevo y SOLO en las
-- combinaciones planta+almacén+oficina que tienen tarifa oficial de PAN en
-- `proan_ZTSD_OV_COM_H_20260829`.
--
-- OJO CON LA MAGNITUD, verificado con datos reales antes de tocar esto: la
-- planta `PANF` factura $107,800 M en TOTAL (37,9 M líneas) -- PAN es una
-- empresa mucho más grande que DBC, y casi todo ese negocio no tiene nada que
-- ver con el huevo de DBC. Filtrar por `company_code = 'PAN'` a secas habría
-- metido esos $107,800 M enteros. `alcance_pan` es lo que recorta esto a la
-- rebanada real ($2,113.9 M), y por eso NO se toca ese criterio aquí.
--
-- "VENDIDO" (VBAP/VBAK) SE QUEDA SOLO-DBC, a propósito, no por omisión:
-- ninguna de las dos tablas trae `company_code`, así que no hay forma
-- confiable de separar líneas de PAN de las de DBC ahí (a diferencia de
-- facturado/cobrado, que sí traen `company_code` en la fuente). Se podría
-- aproximar por planta (`WERKS = 'PANF'`, que hoy solo aparece del lado PAN
-- en facturado -- verificado, cero filas de DBC en esa planta), pero eso es
-- una inferencia, no un dato confirmado, y "vendido" ya no cruza con
-- facturado/cobrado por otras razones (numeración de documento distinta, ver
-- [[flujo_producto_dbc_auditoria]] si existe esa nota) -- no se pierde
-- comparabilidad real por dejarlo así. `sociedad` en esta rama es literal
-- 'DBC' siempre.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc` AS
WITH plantas_dbc AS (
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
  'DBC' AS sociedad,                        -- VBAP/VBAK no traen company_code -- ver el porqué en el comentario de la sección 2, arriba
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
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = p.LGORT AND dc.oficina = k.VKBUR
-- Cada escalón entra solo donde falló el anterior, y la condición va en el ON y
-- no en un CASE posterior: así una línea que ya cruzó no toca las dimensiones
-- de repuesto ni por casualidad.
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
       ON dc.cedis IS NULL AND dal.almacen = p.LGORT
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_nombre_v1` dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = p.LGORT
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = p.WERKS)
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
       ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL
      AND dco.oficina = k.VKBUR
WHERE p.WERKS IN (SELECT planta FROM plantas_dbc)
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
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
       ON dc.cedis IS NULL AND dal.almacen = f.storage_location
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_nombre_v1` dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = f.storage_location
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = f.receiving_plant)
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
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
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_v1` dc ON dc.almacen = f.storage_location AND dc.oficina = f.sales_office
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_almacen_v1` dal
       ON dc.cedis IS NULL AND dal.almacen = f.storage_location
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_nombre_v1` dma
       ON dc.cedis IS NULL AND dal.cedis IS NULL
      AND dma.almacen = f.storage_location
      AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = f.receiving_plant)
LEFT JOIN `proan-quantrue.ZZ_PRUEBAS.dim_cedis_oficina_v1` dco
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
CREATE OR REPLACE VIEW `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc_resumen_diario` AS
SELECT
  fase,
  sociedad,                                 -- 2026-09-10: DBC o PAN, ver el comentario de la sección 2
  fecha,
  division_code,
  division,
  cedis,
  tipo_venta,
  -- `cedis_origen` entra en el GROUP BY para no perder la trazabilidad al
  -- agregar: sin él, un CEDIS que mezcla líneas cruzadas por almacén+oficina
  -- con líneas cruzadas solo por oficina queda indistinguible de uno cruzado
  -- entero, y ya no se puede volver al resultado sin fallback.
  cedis_origen,
  unidad,
  COUNT(*) AS num_lineas,
  SUM(cantidad) AS cantidad_total,
  SUM(cantidad_cajas) AS cantidad_cajas_total,
  SUM(monto) AS monto_total
FROM `proan-quantrue.ZZ_PRUEBAS.v1_flujo_producto_dbc`
GROUP BY fase, sociedad, fecha, division_code, division, cedis, tipo_venta, cedis_origen, unidad;
