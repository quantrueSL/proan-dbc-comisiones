
# Comisiones DBC — Borrador técnico de hallazgos

_Última actualización: 3 de agosto de 2026_

## 1. Objetivo

Plataforma web con dashboard interactivo que centralice y visualice la información operativa y comercial de DBC por cada CEDIS. Consolida datos de SAP para dar visión integral del flujo de producto: entrada de mercancía al CEDIS (traspasos), unidades vendidas, facturadas y compensadas (cobradas), hasta el inventario disponible (**inventarios fuera de alcance por el momento**). El detalle debe llegar a tipo de producto y presentación, y diferenciar tipo de venta (mayoreo, detalle, ruta, etc.).

Componente central: el **módulo de compensación y comisiones**. La comisión se paga solo sobre venta compensada (efectivamente cobrada), así que la plataforma debe reflejar diario el estatus de cada operación (facturada vs. pendiente de cobro a crédito) e integrar la tabla de comisión por unidad vendida, calculando el monto a pagar según tipo de venta, con periodicidad semanal o mensual según el comisionista.

También un **módulo de conciliación documental**: relacionar las facturas emitidas por cada comisionista (proveedor) con sus documentos de pago, para cumplir los requerimientos del SAT en materia de pago de comisiones. Todo con opción de descarga a máximo detalle, incluida la vista de comisión, como respaldo ante auditorías fiscales.

DBC opera como distribuidor: recibe producto y lo distribuye a través de sus CEDIS, que venden a clientes finales. Por cada venta, DBC recibe una comisión, cobrable de inmediato o después de un periodo, según división de producto, CEDIS y oficina de venta.

## 2. Alcance y fuente de datos

Los datos viven en BigQuery, proyecto `proan-quantrue` (región `us-west4`) — compartido por todo el grupo (Proan, DBC, Superdoña, Malta, entre otros), no solo por DBC.

**Filtro maestro:** `company_code = 'DBC'` en la tabla de facturación aísla correctamente los datos de DBC. Las plantas (`receiving_plant` / `WERKS`) bajo este código:

```
DBCF, DBC1, DBC3, H7LA, H7L1, H7L2, H7SL, H7SI, H7AG, H7SM,
H7QU, H7CE, H7SA, H7MI, H7MO, H7UR, H7ZA, H7IR, H7SJ
```

Nota de calidad de datos: sin este filtro, la tabla mezcla divisiones ajenas a DBC. También hay `billing_date` con años inválidos (2201, 2202) que deben excluirse con un rango de fecha razonable.

**Alcance temporal del proyecto:** se consultará información a partir de **enero de 2026** en adelante.

Un reporte de ejemplo recibido del cliente trae `Sociedad = PAN` para división H (huevo) — se confirmó que es parte de un export más amplio del cliente y no cambia el alcance: seguimos filtrando solo DBC.

## 3. Dimensiones resueltas

| Dimensión | Campo origen | Tabla de mapeo | Estado |
|---|---|---|---|
| División de producto | `sales_division` | `D20_DIMENSION.dm_business_area` | Resuelto — 100% cobertura |
| Canal de distribución | `distribution_channel` | `D20_DIMENSION.dm_distribution_channel` | Resuelto — 100% cobertura |
| CEDIS + tipo de venta (ruta/mayoreo/medio mayoreo) | `storage_location` + `sales_office` | `D20_DIMENSION.dm_cedis` | Resuelto — ~92.5% cobertura |
| Tipo de factura | `billing_type` | `D00_SANDBOX.proan_TVFKT_Cobranza_20260728` | Parcial — ~14-32%. No crítico |
| Momento de cobro | `billing_document` | `D50_AGGREGATE_CHATBI.sap_pago` | Resuelto — 75% cobertura; 99.7% de esas ya pagadas |
| Nombre de oficina de venta | `sales_office` | `D00_SANDBOX.proan_TVKBT_20260728` (VKBUR+BEZEI) | Resuelto — más completo que lo que tiene el propio cliente |

Divisiones confirmadas (`Mapeo Divisiones` del cliente): `H` = Huevo (PAN, DBC), `BO` = Botana (DBC), `A` = Abarrote (DBC), `IA` = Alimento (DBC). Coincide con lo ya mapeado vía `dm_business_area`.

Tipo de venta (`dm_cedis.tipo_venta`): VTA EN RUTA, MAYOREO, MED MAYOREO, EXTRAS. Se cruza usando `storage_location = almacen` **y** `sales_office = oficina` en conjunto.

## 4. Modelo de cuatro capas: traspasos, vendido, facturado, cobrado

Los reportes reales que envió el cliente (fuente de verdad) confirman que el flujo completo tiene **cuatro** eslabones, no tres — empieza con la entrada de mercancía al CEDIS:

| Momento | Fuente | Estado |
|---|---|---|
| Traspasos (entrada a CEDIS) | TX `MB51` → candidata `sap_mseg` | Nuevo — por validar |
| Vendido | `sap_VBAK` / `sap_VBAP` (pedido) + `sap_VBFA` (flujo de documentos) | Resuelto y validado |
| Facturado | `sap_2lis_13_vditm_billing_document_item` | Resuelto |
| Cobrado / compensado | `sap_pago` (join por `billing_document`) | Resuelto |

### 4.0 Traspasos (nuevo hallazgo)

El reporte del cliente arranca con columnas `TRA_*` (traspasos = entradas de mercancía a cada almacén/CEDIS), generadas con la transacción `MB51`. No estaba en nuestro modelo original. Candidata en BigQuery: `D30_INTEGRATION.sap_mseg` (movimientos de mercancía) — falta validar que reproduce los mismos totales que `MB51`.

### 4.1 Mapeo de campos por fase (vendido / facturado / cobrado)

| Aspecto | Vendido | Facturado | Cobrado |
|---|---|---|---|
| Tabla clave | `sap_VBAP` + `sap_VBAK` | `sap_2lis_13_vditm_billing_document_item` | `sap_pago` |
| Llave | `VBELN` + `POSNR` | `billing_document` | `billing_document` |
| Fecha | `ERDAT` / `AUDAT` | `billing_date` | `clearing_date` |
| Monto | `NETWR` (ver 4.3 — no confiable) | `amount_mxn` | `paid_amount_mxn` |
| Cantidad | `KWMENG` | `invoiced_quantity` | — |
| División | `SPART` | `sales_division` | `business_area_code` |
| Oficina | `VKBUR` | `sales_office` | — |
| Canal | `VTWEG` | `distribution_channel` | `distribution_channel` |
| Planta/almacén | `WERKS` / `LGORT` | `receiving_plant` / `storage_location` | — |
| Filtro líneas inválidas | `ABGRU` vacío | — | — |
| Enlace al siguiente eslabón | `sap_VBFA`: `VBTYP_V='C'`, `VBTYP_N='M'` | `billing_document` | — |

### 4.2 Validación del cruce vendido → facturado

Pedidos DBC desde agosto 2024: **4,683,010 líneas** vendidas por **7,399,722,956 MXN**. El 97.5% tiene flujo de documento (`VBFA`) hacia una factura; solo 1.24% de las líneas (58,081, ≈200.96M MXN) no tiene ningún flujo hacia factura.

### 4.3 Por qué el gap de monto (13.5%) es mayor que el gap de líneas (2.5%)

Del gap total (996.2M MXN), el 20% (200.96M) viene de líneas sin factura vinculada, y el 80% (795.25M) viene de líneas que sí se facturaron pero donde `NETWR` no coincide con `amount_mxn` — una discrepancia del 11.05%. Se comparó cantidad pedida vs. facturada (193,996,103.18 vs. 193,566,347.39 — gap de solo 0.22%), lo que descarta que sea un tema de entrega parcial: es un tema de **precio** (descuentos/rebates aplicados solo al facturar). `amount_mxn` de facturado sigue siendo el único monto confiable para comisión; `NETWR` de vendido es solo indicativo.

### 4.4 Rango de fechas de "vendido" (resuelto — no es limitante)

`sap_VBAK`/`sap_VBAP` para DBC solo tienen datos desde 2024-08-01, pero el alcance del proyecto es desde enero 2026 — no es limitante.

## 5. Granularidad de producto: SETs, no material_number

Los reportes del cliente (fuente de verdad) muestran columnas por **marca/SET** (`HSANJUAN`, `HPORTALES`, `HINDUS`, `HRANCH` en huevo; `CHOCOL`, `VAINIL`, `CAJETA`, `SWICH`, `BIG_CH`, `VUALA`, `PINA`, `PMUERT` en botana; `CHOP`, `BALU`, `WOOFI`, `BALTO`, `MIXI`, `BONGO` en alimento; `SJABAR` en abarrote), no por `material_number` individual. El cliente confirmó que son SETs de SAP mantenidos vía `GS01`/`GS02`/`GS03`.

Se descartaron dos alternativas para evitar depender del cliente:

- **Tablas de SET en BigQuery** (`SETLEAF`/`SETHEADER`/`SETNODE`): búsqueda vacía, no existen replicadas.
- **Maestro de materiales** (`MATKL_material_group`, `EXTWG_external_group`): no reproducen los SETs. `MATKL` agrupa por color/proceso y mezcla marcas (`H1` mezcla importación + San Juan; `H2` mezcla San Juan rojo + Campiña + Portales). La marca vive en texto libre dentro de `MAKTX_material_description`.

**Solución interina probada** (mientras llega el export de GS03): clasificar por texto en `MAKTX` buscando los nombres de marca ya conocidos por los reportes de cada división (`LIKE '%SAN JUAN%'`, `'%PORTALES%'`, etc.).

**Resultado de la prueba (división Huevo):** San Juan 59,392 · Sin clasificar 33,884 (**32.6%**) · Portales 9,007 · Industrialización 1,508 · Rancho **0**.

**Conclusión: el proxy por texto no es viable, ni como interino.** No es un tema de ajustar keywords — al revisar el detalle de "sin clasificar" aparecen dos problemas estructurales:

- La gran mayoría de esos materiales (KRAFT, SEMILIMPIO, NATUREL, GRANEL, DOBLE YEMA, CAJA PLÁSTICO, JUMBO, "AUTOSERVICIOS", "SORIANA", "EN CARROS", "IMPORTACIÓN") **no mencionan ninguna marca en la descripción** — el texto describe color/empaque/cliente destino, no el SET comercial. Ningún ajuste de keywords soluciona esto porque el dato simplemente no está en `MAKTX`.
- Apareció **CAMPIÑA** como marca real, de alto volumen (varias de las descripciones con más ocurrencias), que no corresponde a ninguna de las 4 columnas del reporte del cliente — no sabemos si es un 5° SET no reportado o si sus ventas se reclasifican a otro SET por otro criterio (planta/CEDIS).
- El motivo de que "Rancho" diera 0: en los datos el texto usado es **"RANCHERO"/"RANCHEROS"**, no "Rancho" — un simple problema de sinónimo, pero confirma lo frágil que es depender de texto libre.

**Decisión:** no usar este proxy para calcular nada, ni siquiera como valor provisional. En su lugar, avanzar la arquitectura con el SET como una **dimensión pendiente/nula** (tabla `material_number → SET`, hoy vacía o parcial) que se va llenando cuando llegue GS03 o una definición del cliente — así el resto del pipeline (traspasos/vendido/facturado/cobrado, reglas de comisión, conciliación) se puede construir y probar sin que datos de clasificación erróneos contaminen los números. Queda pendiente además revisar si el maestro de materiales tiene algún campo de jerarquía (tipo `PRODH` u otro) más confiable que el texto libre.

## 6. Comisión

### 6.1 Tarifas derivadas de los reportes (validación empírica)

Analizando las columnas `COM_` de los reportes del cliente se pudo derivar la estructura real de la tarifa: es un **importe fijo por caja (CJ)**, no un porcentaje, y varía por **SET de producto, CEDIS y oficina** — no es una tasa única por división:

| SET | CEDIS | Tarifa $/caja |
|---|---|---|
| San Juan | León 1, Querétaro, Salamanca | 1.50 |
| San Juan | Silao, Aguascalientes 1 | 1.45 |
| San Juan | Aguascalientes 2 | 1.15 |
| San Juan | Zacatecas | 1.80 |
| San Juan | Uruapan | 2.15 |
| San Juan | San Cristóbal | 0.30 |
| Portales | mayoría de CEDIS | 1.05 |
| Portales | Uruapan | 0.95 |
| Portales | Irapuato | 0.90 |
| Portales | Aguascalientes 2 | 0.85 |
| Portales | León Abastos | 0.70 |

Incluso varía dentro del mismo CEDIS según la oficina (Aguascalientes 1 = oficina 0019 → 1.45; Aguascalientes 2 = oficina 0121 → 1.15, ambos San Juan). Esto valida el diseño de tabla de reglas configurable: la llave real es **SET × CEDIS × oficina**, con vigencia.

### 6.2 Tabla de reglas propuesta

```
division | set_producto (opcional) | cedis (opcional) | oficina (opcional) | tipo_venta (opcional) | tasa_comision | vigente_desde | vigente_hasta
```

Columnas de dimensión opcionales (`NULL` = "aplica a todos"). La plataforma busca, para cada transacción, la regla más específica que aplique. Cuando el negocio cambie una tasa, solo se edita esta tabla.

### 6.3 Las tres medidas de venta del reporte

El reporte del cliente distingue tres cálculos, y las cifras reales (Celaya, semana 19-25 jul 2025) muestran la relación entre ellas:

| Medida | Cajas | Importe |
|---|---|---|
| Ventas totales | 483,447.49 | $19,707,964.34 |
| Créditos (vendido no cobrado) | 1,999.99 | $81,530.53 |
| Ventas debidamente compensadas (= totales − créditos) | 481,447.50 | $19,626,433.81 |
| Lo compensado en la fecha de ejecución | 572,947.97 | $23,356,493.31 |

"Ventas debidamente compensadas" es la base que usan **hoy** para pagar comisión (ventas de la semana ya cobradas). "Lo compensado en la fecha de ejecución" es la base que **quieren** usar: todo el dinero efectivamente cobrado ese día, venga de la venta que venga — esto es exactamente `sap_pago.clearing_date`, coherente con lo que ya veníamos armando. **No es un cambio de regla de negocio** (la comisión sigue pagándose solo sobre venta compensada, como dice el objetivo detallado); es un cambio de cómo se mide "compensado": hoy se aproxima desde ventas, y se quiere medir directo desde el pago. La diferencia entre ambas medidas puede ser grande (~19% en este ejemplo) y conviene poder explicarla cuando el cálculo nuevo no cuadre con lo que se paga hoy.

## 7. Módulo de conciliación y comisionistas

El reporte cierra con **Factura Proveedor (comisionista)**: factura + documento de compensación, obtenidos vía `FBL1N` (partidas de proveedor). Candidata en BigQuery: `sap_bsik_open_items`. Falta el rango de número de proveedor que identifica comisionistas y su frecuencia de liquidación.

Un comisionista agrupa varias oficinas de venta (ej. `0019-0092`, `0005-0071`, `0012-0145`). El propio reporte del cliente marca esto como pendiente ("PENDIENTE NOMBRE OFICINA DE VENTAS") — no lo tienen resuelto ni ellos. Nuestra fuente `proan_TVKBT_20260728` (oficina + nombre) más `dm_cedis` puede ayudar a reconstruir la relación, pero falta la agrupación por comisionista específicamente.

## 8. Conversión de unidades a caja (CJ)

La comisión se paga por caja, pero `invoiced_quantity` en facturación viene en unidades mixtas (`CS`, `PZA`, `PAQ`, `SAC`). Existen `denominator_conversion_sku` (en facturación) y `MEINS_base_unit`/`MEINH_alternative_unit` (en el maestro) como candidatos para la conversión. **Pendiente, se revisará más adelante con detenimiento** — no bloquea el avance actual.

## 9. Pendientes y riesgos abiertos (internos)

| # | Tema | Detalle |
|---|---|---|
| 1 | Duplicados en el cruce con `dm_cedis` | Algunas combinaciones de almacén + oficina tienen más de un "sector" asociado, generando filas duplicadas (fan-out). Falta regla de desempate. |
| 2 | DERIVADOS DE GANADO no cruza | Planta DBC1 / almacén DG01 no encontró registro en `dm_cedis`. |
| 3 | Campo de importe oficial en facturado | Confirmar cuál columna de monto es "lo facturado" ante Hacienda. |
| 4 | Calidad de fechas | `billing_date` con años inválidos (2201, 2202) — filtrar rango razonable. |
| 5 | Datasets por explorar | `D40_EDW`, `D60_REPORTING`, `D62_STREAMLIT` — no se pudo listar su contenido, confirmar si es tema de permisos. |
| 6 | Proxy de SET por texto — **descartado** | Probado en división Huevo: 32.6% sin clasificar, "Rancho" con 0 matches, marca "Campiña" no contemplada. No es viable ni como interino (ver sección 5). Se avanza con SET como dimensión pendiente/nula hasta GS03. |
| 7 | Conversión a CJ | Ver sección 8 — pendiente de revisar. |
| 8 | Validar traspasos vía `sap_mseg` | Confirmar que reproduce los totales de `MB51` (sección 4.0). |

## 10. Preguntas pendientes para el cliente

1. **Export de GS03** con la definición de los SETs de producto (marca/línea → materiales) para cada división.
2. **Tabla oficial de tarifas de comisión** (TX `ZSDFI_001`) — por ahora solo tenemos tarifas derivadas empíricamente de los reportes (sección 6.1), no la fuente oficial.
3. **Relación comisionista ↔ oficinas de venta**, con nombre — el cliente mismo lo marca como pendiente en su reporte.
4. **Rango de número de proveedor** que identifica comisionistas en SAP, y su **frecuencia de liquidación** (semanal/mensual).

## 11. Propuesta de arquitectura (borrador)

**Capa de datos:** vista (o tabla materializada, refrescada diariamente) en BigQuery que una las cuatro fases — traspasos, vendido, facturado, cobrado — con los catálogos de división, canal, CEDIS/tipo de venta y la tabla de reglas de comisión (sección 6.2). Dejar explícito que el monto de "vendido" es indicativo y que la clasificación por SET (sección 5) es una aproximación temporal.

**Capa de consulta:** MVP rápido con dashboard conectado a la vista para validar con usuarios reales, y eventualmente la plataforma dedicada con los tres módulos del objetivo detallado (flujo de producto, comisiones, conciliación documental) y exportación a máximo detalle.

## 12. Próximos pasos

- Enviar al cliente las 4 preguntas de la sección 10.
- Validar `sap_mseg` contra `MB51` para traspasos.
- Proxy de SET por texto descartado (sección 5) — construir el pipeline con SET como dimensión pendiente/nula y revisar si el maestro de materiales tiene un campo de jerarquía más confiable que el texto libre.
- Confirmar con negocio la causa exacta del gap de precio en "vendido" (sección 4.3) — no bloqueante.
- Resolver pendientes internos #1 a #5 de la sección 9.
- Con eso, construir la vista de datos definitiva (4 capas + reglas de comisión) y un primer prototipo de consulta.

## 13. Estado frente al objetivo (resumen ejecutivo)

### 13.1 Por módulo del objetivo detallado

| Módulo del objetivo | Qué tenemos | Brecha principal |
|---|---|---|
| Dashboard por CEDIS (flujo de producto) | 3 de 4 capas resueltas y validadas (vendido, facturado, cobrado); traspasos identificado, falta validar. División, canal, CEDIS y tipo de venta resueltos (92.5-100%). | Traspasos sin validar contra `MB51`; datasets `D40/D60/D62` sin explorar. |
| Comisión y compensación | Estructura de tarifa entendida y validada con datos reales del cliente ($/caja por SET × CEDIS × oficina); tabla de reglas configurable diseñada; medida de "compensado" alineada al objetivo (`sap_pago.clearing_date`). | Sin el mapeo material→SET no se puede calcular ninguna comisión real todavía — es el bloqueante único de este módulo. Falta también la tarifa oficial (`ZSDFI_001`) y la agrupación comisionista↔oficinas. |
| Conciliación documental (SAT) | Fuente candidata identificada (`FBL1N` → `sap_bsik_open_items`). | Prácticamente sin explorar — falta validar la tabla, y falta el rango de proveedor que identifica comisionistas. |

### 13.2 Granularidad de categorización

- **División, CEDIS, tipo de venta:** resuelto, listo para producción (92.5-100% de cobertura).
- **Producto:** aquí hay una distinción importante. Para el **dashboard** (objetivo: "detalle a tipo de producto y presentación"), ya tenemos más granularidad de la pedida — `material_number` individual, más fino que el SET. Para la **comisión**, en cambio, se necesita agrupar por SET (marca/línea), y ese mapeo no existe todavía sin GS03 — el proxy por texto quedó descartado. Es decir: podemos mostrar el detalle máximo en el dashboard hoy, pero no podemos calcular comisión real hasta tener el mapeo material→SET.

### 13.3 Granularidad temporal

- Vendido, facturado y cobrado ya tienen fecha a nivel transacción (`ERDAT`/`AUDAT`, `billing_date`, `clearing_date`) y se pueden refrescar a diario, alineado con el objetivo de "reflejar diario el estatus de cada operación". Traspasos, en principio, también (`MB51`/`sap_mseg`), pendiente de validar.
- Periodicidad de pago de comisión (semanal/mensual según comisionista) queda cubierta por el diseño de la tabla de reglas (`vigente_desde`/`vigente_hasta`), pero para aplicarla por comisionista específico falta la agrupación oficinas↔comisionista.
- El alcance desde enero 2026 no choca con ninguna limitación de historia de datos encontrada.

### 13.4 Lectura general

El modelo de datos (4 capas), la estructura de tarifa y el diseño de reglas están validados contra reportes reales del cliente — la arquitectura de fondo está alineada con el objetivo. Lo que falta para completar los 3 módulos no es diseño ni exploración de datos propios, es **información que solo puede dar el cliente**: GS03 (SETs), `ZSDFI_001` (tarifa oficial), comisionista↔oficinas, y rango de proveedor/frecuencia. El área que sí depende de nosotros y sigue abierta es conciliación documental (módulo 3), casi sin explorar todavía, y la validación de traspasos.
