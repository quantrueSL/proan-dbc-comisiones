-- =============================================================================
-- DIMENSIÓN · base de cálculo de la comisión, por división
-- =============================================================================
-- Una fila por división de DBC diciendo si su comisión se paga por kg o por
-- caja, si el cliente lo confirmó, y con qué fundamento. Es la única regla de
-- negocio de este proyecto que está escrita como dato y no enterrada en un
-- CASE, a propósito: quien la cambie tiene que dejar constancia de por qué.
--
-- La consume `D50_AGGREGATE.DBC_comisiones_calculadas_cobro` con un JOIN por
-- `division_code`, para decidir si multiplica la tarifa por kilos o por cajas.
--
-- PROCEDENCIA: hasta el 2026-09-24 vivía dentro de `Datos/sql/v1_comision_dbc.sql`
-- (sección 3), un archivo que además crea cuatro vistas que ya no usa nadie
-- (`dim_tipo_venta_v1`, `dim_tarifa_v1`, `dim_tarifa_unica_v1`,
-- `v1_comision_linea`). Aquí se extrae SOLO esta, sin tocar una coma de su
-- contenido — por eso ese archivo no se puede borrar entero en la limpieza
-- pendiente, pero sí en cuanto esta vista viva aquí.
--
-- CÓMO SE DEDUJO CADA UNA (la aritmética que lo decidió, % sobre facturado):
--
--                    tarifa    si fuera    si fuera
--      división      $/unidad   por caja    por kilo
--      ────────────────────────────────────────────────────────────────────
--      huevo          18,36      0,21%       3,91%   <- kilo, confirmado
--      botana          0,06      8,59%       0,53%   <- caja, sin duda
--      croqueta        6,09      1,22%       7,31%   <- kilo, confirmado
--      leche            n/a      6,33%         n/a   <- pieza
--
-- La croqueta estuvo en `caja` hasta tener la confirmación de Alejandro del
-- 26/08/2026, aunque la aritmética ya la señalaba: deducir bien no es lo mismo
-- que saber, y ya nos pasó con "CEDIS SAN JUAN", que se llamaba CEDIS y no lo
-- era.
--
-- ABARROTES (A) SIGUE SIN BASE (`NULL`) y no es un olvido: no usa ni SET ni
-- tipo de venta, va por margen sobre el precio de cada material. Necesita su
-- propio motor de cálculo, que no existe todavía.
-- =============================================================================
CREATE OR REPLACE VIEW `proan-quantrue.D20_DIMENSION.dm_DBC_base_comision_v1` AS
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
         'abarrotes no usa ni SET ni tipo de venta: va por margen sobre el precio de cada material. Necesita su propio motor')
]);
