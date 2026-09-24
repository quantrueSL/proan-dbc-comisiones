-- CANDIDATO DE MIGRACIÓN, NO EJECUTADO TODAVÍA -- no forma parte de la cadena viva.
--
-- CORREGIDO 2026-09-24: la primera versión de este archivo llamaba por dentro a
-- las 4 vistas viejas de ZZ_PRUEBAS (dim_cedis_v1, _almacen_v1, _nombre_v1,
-- _oficina_v1) -- eso junta el JOIN en un solo lugar pero NO reduce cuántas
-- tablas existen, las 4 seguirían haciendo falta debajo. Esta versión trae la
-- lógica de cada escalón inline, directo de las fuentes reales
-- (D20_DIMENSION.dm_cedis y ZZ_PRUEBAS.DBC_dim_almacen_nombre) -- así, una vez
-- migrados los consumidores, las 4 vistas viejas sí se pueden retirar de verdad.
-- Cada escalón es copia literal de la definición que hoy vive en
-- v1_flujo_producto_dbc.sql (secciones 1, 1b, 1c y "el mapeo manual" /
-- dim_cedis_nombre_v1) -- ningún detalle (desempates, exclusiones de oficina
-- cajón de sastre, normalización de nombre) se cambió, solo se movió de sitio.
--
-- Probado 2026-09-24 con SELECT de solo lectura contra BigQuery (sin crear nada,
-- usando la versión "wrapper" anterior, que da el mismo resultado que esta por
-- construcción -- misma lógica, solo que antes llamaba a las vistas y ahora la
-- trae inline):
--   - 379 combos reales de DBC_silver_flujo_producto: 0 discrepancias en cedis/
--     tipo_venta/cedis_origen contra el resultado que ya produce
--     v1_flujo_producto_dbc.sql con las 4 vistas por separado.
--   - Aplicado a las 4.124.276 líneas de dbc_comisiones_calculadas_cobro: resuelve
--     1.275 líneas / $9.613.778 (0,32% del importe) que hoy Conciliación deja sin
--     CEDIS por saltarse el escalón "nombre".
--
-- OJO DE RENDIMIENTO, sin verificar todavía: al ser función de tabla, cada
-- llamada puede volver a escanear dm_cedis/DBC_dim_almacen_nombre -- son tablas
-- chicas (cientos de filas), pero con 4+ millones de líneas en
-- dbc_comisiones_calculadas_cobro conviene medir bytes/costo real antes de
-- adoptarla ahí (Fase 2 de despliegue, más abajo). Si el costo no convence, la
-- alternativa es materializar esta misma lógica como TABLA (no función) una vez
-- al refresco del pipeline, igual que las demás dimensiones.
--
-- Plan de despliegue (ver conversación 2026-09-24, "no romper el flujo actual"):
--   Fase 1: correr este CREATE por separado. No toca ni reemplaza las 4 vistas
--           viejas, así que v1_flujo_producto_dbc.sql, v1_conciliacion_factura_linea.sql
--           y v1_comision_dbc_completo_cobro.sql siguen funcionando exactamente igual.
--   Fase 2: validar la función ya creada -- mismas comparaciones de esta sesión,
--           esta vez contra el objeto real, más medir bytes escaneados/costo.
--   Fase 3: migrar UN archivo consumidor a la vez, comparando su tabla de salida
--           antes/después de cambiar el JOIN, antes de sustituir la tabla en
--           producción. Empezar por v1_conciliacion_factura_linea.sql, que es el
--           que gana cobertura real.
--   Fase 4: cuando ningún archivo vivo referencie ya las 4 vistas viejas
--           (mismo método de verificación que con las tablas huérfanas: grep +
--           INFORMATION_SCHEMA.JOBS_BY_PROJECT), retirarlas.

CREATE OR REPLACE TABLE FUNCTION `proan-quantrue.D20_DIMENSION.dm_DBC_resolver_cedis`(
  p_almacen STRING, p_oficina STRING, p_planta STRING
) AS (
  WITH

  -- Escalón 1 (almacén+oficina) -- copia literal de dim_cedis_v1.
  escalon_1 AS (
    SELECT * EXCEPT (rn)
    FROM (
      SELECT almacen, oficina, cedis, sector, tipo_venta,
             ROW_NUMBER() OVER (PARTITION BY almacen, oficina ORDER BY sector) AS rn
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
    )
    WHERE rn = 1
  ),

  -- Escalón 2 (solo almacén, inequívocos) -- copia literal de dim_cedis_almacen_v1.
  escalon_2_almacen AS (
    SELECT almacen, ANY_VALUE(cedis) AS cedis
    FROM (
      SELECT almacen, cedis
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
      GROUP BY almacen, cedis
    )
    GROUP BY almacen
    HAVING COUNT(*) = 1
  ),

  -- Escalón 3 (lista de nombres del cliente) -- copia literal de dim_cedis_nombre_v1.
  escalon_3_nombre AS (
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
    SELECT * EXCEPT (rn)
    FROM (
      SELECT
        IFNULL(l.planta, '') AS planta,
        l.almacen,
        l.origen,
        COALESCE(c.cedis, l.nombre_cedis) AS cedis,
        ROW_NUMBER() OVER (
          PARTITION BY l.almacen
          ORDER BY IF(l.origen = 'deducido', 0, 1), l.planta DESC, l.nombre_cedis
        ) AS rn
      FROM lista l
      LEFT JOIN catalogo c ON c.clave = l.clave
    )
    WHERE rn = 1
  ),

  -- Escalón 4 (solo oficina, sin cajones de sastre) -- copia literal de dim_cedis_oficina_v1.
  escalon_4_oficina AS (
    WITH oficinas_utiles AS (
      SELECT oficina
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
      GROUP BY oficina
      HAVING COUNT(DISTINCT almacen) > 1
    )
    SELECT * EXCEPT (filas, rn)
    FROM (
      SELECT
        oficina, cedis, tipo_venta,
        COUNT(*) AS filas,
        ROW_NUMBER() OVER (
          PARTITION BY oficina
          ORDER BY COUNT(*) DESC, cedis, tipo_venta
        ) AS rn
      FROM `proan-quantrue.D20_DIMENSION.dm_cedis`
      WHERE oficina IN (SELECT oficina FROM oficinas_utiles)
      GROUP BY oficina, cedis, tipo_venta
    )
    WHERE rn = 1
  )

  SELECT
    COALESCE(dc.cedis, dal.cedis, dma.cedis, dco.cedis) AS cedis,
    COALESCE(dc.tipo_venta, dco.tipo_venta) AS tipo_venta,
    CASE WHEN dc.cedis  IS NOT NULL THEN 'almacen+oficina'
         WHEN dal.cedis IS NOT NULL THEN 'solo almacen'
         WHEN dma.cedis IS NOT NULL THEN 'lista de nombres'
         WHEN dco.cedis IS NOT NULL THEN 'solo oficina'
    END AS cedis_origen
  FROM (SELECT 1) _
  LEFT JOIN escalon_1 dc
         ON dc.almacen = p_almacen AND dc.oficina = p_oficina
  LEFT JOIN escalon_2_almacen dal
         ON dc.cedis IS NULL AND dal.almacen = p_almacen
  LEFT JOIN escalon_3_nombre dma
         ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.almacen = p_almacen
        AND (dma.planta IS NULL OR dma.planta = '' OR dma.planta = p_planta)
  LEFT JOIN escalon_4_oficina dco
         ON dc.cedis IS NULL AND dal.cedis IS NULL AND dma.cedis IS NULL AND dco.oficina = p_oficina
);

-- Uso desde un consumidor, por ejemplo v1_conciliacion_factura_linea.sql:
--   SELECT r.cedis, r.tipo_venta, r.cedis_origen
--   FROM base t, UNNEST([dm_DBC_resolver_cedis(t.almacen, t.oficina_ventas, t.planta)]) r
-- en vez de los 3-4 LEFT JOIN encadenados contra las vistas viejas.
--
-- Nota: la fuente `ZZ_PRUEBAS.DBC_dim_almacen_nombre` en el escalón 3 hay que
-- repuntarla a `D20_DIMENSION.dm_DBC_almacen_nombre` cuando esa tabla se migre
-- (ver dataset_destino_tablas_dbc) -- son el mismo dato, dos nombres distintos
-- en momentos distintos de la migración.
