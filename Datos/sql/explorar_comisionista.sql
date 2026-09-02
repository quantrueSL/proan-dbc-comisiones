-- =============================================================================
-- Cómo encontrar el pago real a un comisionista y compararlo contra lo calculado.
-- Solo lectura. Cambia 'FLORENTINO', '0000001019' y las fechas/oficina/división
-- para investigar a alguien más.
-- =============================================================================

-- 1) Encontrar al comisionista como PROVEEDOR (no como cliente) por nombre + CEDIS.
SELECT id_proveedor, razon_social, nombre_comercial, municipio, estado_cod
FROM `proan-quantrue.D20_DIMENSION.dm_vendors`
WHERE UPPER(razon_social) LIKE '%FLORENTINO%';


-- 2) Su historial de liquidaciones. sap_bsik_open_items es la tabla EN VIVO -- solo
-- muestra lo que sigue abierto/sin pagar hoy. Para ver liquidaciones ya pagadas
-- hace falta barrer las fotos diarias `proan_BSIK_YYYYMMDD` en D00_SANDBOX, que sí
-- se conservan. `_TABLE_SUFFIX` las junta todas en una sola consulta.
--
-- OJO: BUKRS sale 'PAN', no 'DBC' -- las comisiones se liquidan por el otro
-- company_code aunque la venta sea de DBC.
SELECT _TABLE_SUFFIX AS foto, BUDAT AS fecha_contable, DMBTR AS monto,
       SGTXT AS concepto, GSBER AS division, AUGDT AS fecha_pago, BUKRS
FROM `proan-quantrue.D00_SANDBOX.proan_BSIK_*`
WHERE _TABLE_SUFFIX BETWEEN '20260420' AND '20260520'
  AND LIFNR = '0000001019'
ORDER BY foto;


-- 3) Con la liquidación real ya identificada (ej. "COMISION CROQUETA 25-30 ABRIL"
-- = $3,842.77), comparar contra lo que calcula nuestra tabla para la misma
-- división + oficina + semana. Ajusta oficina_ventas, division y fechas.
SELECT
  COUNT(DISTINCT billing_document) AS n_facturas,
  COUNT(*) AS n_lineas,
  ROUND(SUM(comision_mxn), 2) AS comision_calculada
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
WHERE division = 'IA'
  AND oficina_ventas = '0011'
  AND billing_date BETWEEN '2026-04-25' AND '2026-04-30';


-- 4) Si no cuadra, desglosar por SET para ver si el problema es una tarifa
-- puntual o algo que afecta a todos los productos por igual.
SELECT set_material,
  ROUND(SUM(cantidad), 2) AS kg_total,
  tarifa,
  ROUND(SUM(comision_mxn), 2) AS comision
FROM `proan-quantrue.ZZ_PRUEBAS.dbc_comisiones_calculadas_cobro`
WHERE division = 'IA'
  AND oficina_ventas = '0011'
  AND billing_date BETWEEN '2026-04-25' AND '2026-04-30'
GROUP BY set_material, tarifa
ORDER BY comision DESC;
