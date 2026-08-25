-- =============================================================================
-- GOLD · Comisión DBC — agregado diario para la pantalla de comisiones
-- =============================================================================
-- Sale de `ZZ_PRUEBAS.v1_comision_linea` (correr antes
-- `Datos/sql/v1_comision_dbc.sql`, que crea sus cinco vistas en orden).
--
-- Grano: fecha × división × CEDIS × oficina × comisionista × tipo de venta ×
-- SET × base de cálculo × estado de la comisión × cómo se resolvió el tipo de
-- venta. Unas 99.000 filas.
--
-- POR QUÉ EXISTE, igual que en el flujo: cada consulta a `v1_comision_linea`
-- escanea 0,53 GiB porque rehace el cruce contra silver y contra la línea de
-- factura. Filtrar en pantalla sobre eso sería pagar medio giga por clic. Esta
-- tabla son unos 12 MB.
--
-- EL `comision_estado` VA EN EL GRANO, y es la decisión de diseño que sostiene
-- toda la pantalla. Si se agregara sin él, quedaría un total de comisión que
-- parece completo y no lo es: hoy solo el 44% del facturado en alcance llega a
-- tener tarifa. Con el estado en el grano, la pantalla puede enseñar el total y,
-- al lado, exactamente qué falta para que el resto entre — y cuánto vale.
--
-- LA COMISIÓN NO SE SUMA CON EL IMPORTE, obviamente, pero hay una trampa menos
-- obvia: `cantidad_base_total` mezcla kilos y cajas si se suma entre divisiones.
-- Por eso `base_unidad` va también en el grano. Quien pinte esto: no sumes
-- `cantidad_base_total` sin separar por `base_unidad`.
--
-- EL COMISIONISTA sale de `DBC_dim_almacen_oficina`, que es la única fuente
-- limpia: 104 oficinas, 86 con persona, y ninguna con dos. La tabla de tarifas
-- también trae `persona`, pero ahí 46 pares (división, oficina) tienen más de
-- una y no sirve para atribuir. El 99,2% de la comisión calculada cae en una
-- oficina con comisionista con nombre.
-- =============================================================================

CREATE OR REPLACE TABLE `proan-quantrue.ZZ_PRUEBAS.DBC_gold_comision_diaria`
PARTITION BY fecha
CLUSTER BY division_code, cedis, comision_estado
AS
WITH comisionista AS (
  -- Una fila por (oficina, división). Comprobado que no hay ninguna con dos
  -- personas, así que el ANY_VALUE no está eligiendo entre alternativas: está
  -- colapsando repeticiones idénticas de la misma persona en varios almacenes.
  SELECT
    oficina,
    division,
    ANY_VALUE(NULLIF(TRIM(persona), '')) AS persona
  FROM `proan-quantrue.ZZ_PRUEBAS.DBC_dim_almacen_oficina`
  GROUP BY oficina, division
)
SELECT
  v.fecha,
  v.division_code,
  v.division,
  v.cedis,
  v.oficina,
  c.persona AS comisionista,
  v.tipo_venta,
  v.`set`,
  v.base_unidad,
  v.comision_estado,
  -- Qué escalón encontró la tarifa: 'equivalencia literal' (los cuatro rótulos
  -- que se traducen palabra por palabra) o 'única tarifa de la oficina' (el
  -- segundo escalón, que resuelve MENUDEO, ABASTOS, EXTRAS y las líneas sin
  -- tipo). El segundo es deducción nuestra y está pendiente de confirmar con el
  -- cliente, así que va en el grano: si desmiente algo, se aísla filtrando por
  -- esta columna en vez de rehacer el cálculo.
  v.tipo_venta_origen,

  COUNT(*)                AS num_lineas,
  SUM(v.monto)            AS monto_total,
  SUM(v.cantidad_base)    AS cantidad_base_total,
  SUM(v.comision)         AS comision_total,

  -- La horquilla de lo que está en conflicto entre las dos hojas del cliente.
  -- Solo tiene valor donde `comision_estado = 'tarifa en conflicto entre hojas'`;
  -- en el resto es NULL, que es lo correcto: no hay horquilla que enseñar.
  SUM(v.comision_min)     AS comision_min_total,
  SUM(v.comision_max)     AS comision_max_total,

  -- Lo que además tiene un cobro registrado. NO es "lo que se debe pagar":
  -- `sap_pago` solo ve el 27% del facturado (ver la cabecera de
  -- v1_comision_linea). Es el suelo conocido, no la cifra pagable.
  SUM(IF(v.factura_cobrada, v.comision, 0)) AS comision_cobrada,
  SUM(IF(v.factura_cobrada, v.monto, 0))    AS monto_cobrado,

  -- Líneas con cantidad entregada e importe cero. Se comisionan, pero contadas
  -- aparte para poder aislarlas si el cliente dice que no deberían.
  COUNTIF(v.nota IS NOT NULL) AS lineas_sin_importe
FROM `proan-quantrue.ZZ_PRUEBAS.v1_comision_linea` v
LEFT JOIN comisionista c
       ON c.oficina = v.oficina AND c.division = v.division_code
GROUP BY
  v.fecha, v.division_code, v.division, v.cedis, v.oficina, comisionista,
  v.tipo_venta, v.`set`, v.base_unidad, v.comision_estado, v.tipo_venta_origen;
