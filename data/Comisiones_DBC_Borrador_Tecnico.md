
# Comisiones DBC — Borrador técnico de hallazgos

_Última actualización: 12 de agosto de 2026_

> **Aviso del 21 de agosto de 2026.** Las cifras de este borrador son de la
> corrida del 12 de agosto y **tres de ellas ya no valen**: `sap_VBAP` se puso al
> día (vendido ya no se corta el 20 de julio), el cobrado estaba inflado un 53%
> porque `sap_pago` copia el importe en cada partida y en cada compensación, y el
> pendiente #7 —la conversión a caja— está resuelto en las tres fases, no solo en
> facturado. Las cifras vigentes están en `data/Resumen.md` y el detalle de qué
> cambió y por qué, en `data/notas/hallazgos.md`. Este documento se mantiene como
> lo que es: el registro de lo que se sabía entonces.

## 1. Objetivo

Plataforma web con dashboard interactivo que centralice y visualice la información operativa y comercial de DBC por cada CEDIS. Consolida datos de SAP para dar visión integral del flujo de producto: entrada de mercancía al CEDIS (traspasos), unidades vendidas, facturadas y compensadas (cobradas), hasta el inventario disponible (**inventarios fuera de alcance por el momento**). El detalle debe llegar a tipo de producto y presentación, y diferenciar tipo de venta (mayoreo, detalle, ruta, etc.).

Componente central: el **módulo de compensación y comisiones**. La comisión se paga solo sobre venta compensada (efectivamente cobrada), así que la plataforma debe reflejar diario el estatus de cada operación (facturada vs. pendiente de cobro a crédito) e integrar la tabla de comisión por unidad vendida, calculando el monto a pagar según tipo de venta, con periodicidad semanal o mensual según el comisionista.

También un **módulo de conciliación documental**: relacionar las facturas emitidas por cada comisionista (proveedor) con sus documentos de pago, para cumplir los requerimientos del SAT en materia de pago de comisiones. Todo con opción de descarga a máximo detalle, incluida la vista de comisión, como respaldo ante auditorías fiscales.

DBC opera como distribuidor: recibe producto y lo distribuye a través de sus CEDIS, que venden a clientes finales. Por cada venta, DBC recibe una comisión, cobrable de inmediato o después de un periodo, según división de producto, CEDIS y oficina de venta.

## 2. Alcance y fuente de datos

Los datos viven en BigQuery, proyecto `proan-quantrue` (región `us-west4`) — compartido por todo el grupo (Proan, DBC, Superdoña, Malta, entre otros), no solo por DBC.

**Filtro maestro:** `company_code = 'DBC'` en la tabla de facturación aísla correctamente los datos de DBC (confirmado también en `sap_pago` — no en `sap_VBAK`/`sap_VBAP`, que no tienen este campo). Las plantas (`receiving_plant` / `WERKS`) bajo este código — lista corregida contra `SELECT DISTINCT receiving_plant WHERE company_code = 'DBC'` (la versión original de esta lista no traía `H7DU` ni `H7TX`, lo que dejaba fuera datos reales de "vendido", que depende de esta lista al no tener `company_code` propio):

```
DBCF, DBC1, DBC3, H7LA, H7L1, H7L2, H7SL, H7SI, H7AG, H7SM,
H7QU, H7CE, H7SA, H7MI, H7MO, H7UR, H7ZA, H7IR, H7SJ, H7DU, H7TX
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

Intentado (12 ago 2026) contra el único ejemplo real disponible en los excels del cliente (Sociedad `PAN`, Centro `PANF`, Almacén `H701`, semana 19-25 jul 2025, total `344,102.52`) — inconcluso: ninguna combinación de tipo de movimiento (`BWART`) disponible en `sap_mseg` para ese centro/almacén/semana reproduce el total, ni en cantidad (cajas) ni en importe (se probó el candidato lógico `301/S`, traspaso recibido, sin éxito). No es evidencia en contra de `sap_mseg` — falta que el cliente confirme qué código(s) `BWART` usa su MB51 para "traspasos" (nueva pregunta, ver sección 15.2 punto 7). Ver pendiente #8, sección 9.

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

Revisado (12 ago 2026), con acceso completo a BigQuery: `SETLEAF`/`SETHEADER`/`SETNODE`/`GS01`/`GS02`/`GS03`/`ZSDFI` confirmados como no existentes en **ningún** dataset del proyecto (antes esto no se pudo verificar del todo por permisos, ver pendiente #5 sección 9) — no hay atajo, GS03 sigue siendo estrictamente necesario del cliente. `PRODH` sí existe (solo en los snapshots diarios `D00_SANDBOX.proan_2LIS_13_VDITM_*`, no en la tabla principal), pero tampoco separa las marcas limpiamente: en división Huevo, el código `0000400001` mezcla materiales "SAN JUAN" y "PORTALES" — parece agrupar por formato/presentación, no por marca comercial. Descartado como sustituto de GS03 (ver pendiente #11, sección 9).

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

Revisado (12 ago 2026): `D30_INTEGRATION.sap_bsik_open_items` (candidata vía `FBL1N`) sí tiene la estructura esperada (proveedor, compensación, cuenta contable, importe, término de pago). No existe en BigQuery ningún maestro de proveedores con nombre (tipo `LFA1`) — no se puede mapear número de proveedor a nombre de comisionista por cuenta propia. El universo de proveedores por división es manejable (7 en Abarrote, 155 en Huevo, 112 en Botana, 70 en Alimento — no miles) pero mezclado con proveedores normales de insumos. Sigue dependiendo de la respuesta del cliente a la pregunta 4 (sección 10/15.2) — ver pendiente #12, sección 9.

> **Corrección del 1 de septiembre de 2026 (Silvana):** sí existe un maestro tipo
> `LFA1` — `D20_DIMENSION.dm_vendors` (`razon_social`, `nombre_comercial`, RFC,
> dirección). No se había buscado con ese nombre antes. Usado con éxito para
> identificar a un comisionista real (Florentino González García, proveedor
> `0000001019`) a partir de su liquidación en BSIK. El bloqueante real no es la
> ausencia de la tabla: es que cruzarla por nombre contra las tablas de
> comisionistas del cliente (`DBC_dim_almacen_oficina`, `DBC_dim_comision_tarifa`)
> casi no funciona por nombres abreviados/apodos — solo 1 de 26 personas cruza
> exacto, y por nombre de pila se llega a cientos de candidatos porque
> `dm_vendors` es el maestro de todo el grupo Proan, no solo comisionistas.
> Detalle en `Datos/Comisiones_DBC_Borrador_Tecnico.md`, sección 16.3.

## 8. Conversión de unidades a caja (CJ) — RESUELTO

La comisión se paga por caja, pero `invoiced_quantity` en facturación viene en unidades mixtas (`CS`, `PZA`, `PAQ`, `SAC`, `KG`, entre otras). El monto facturado en `CS` es solo 50.6% del total DBC 2026 (V12 de `v1_verificaciones.sql`) — el resto (`PAQ` 31.2%, `KG` 9.3%, `PZA` 5.5%, `SAC` 3.0%) sí necesitaba conversión, no era un tema marginal.

Se probaron dos candidatos ya presentes en `sap_2lis_13_vditm_billing_document_item` (confirmados vía la consulta de referencia del senior + `INFORMATION_SCHEMA`):

- `denominator_conversion_sku` — **descartado**. En la muestra de `PAQ`/`PZA` es literalmente `1` en todas las filas sin importar material ni cantidad; en `KG` no guarda relación consistente con `invoiced_quantity` (razones 100/50/25/20/4/3.57 sin patrón). No es un factor de conversión confiable.
- `stockkeeping_units` — **confirmado como la solución**. `invoiced_quantity / stockkeeping_units` da un factor constante por material a través de miles de filas (ej. ~18.00 kg/caja para un material, factor exacto 1.0 para la mayoría de materiales en `PAQ`/`SAC`/`PZA`), validado sobre los 50 casos de peor varianza de todo el dataset (V14) — y sin NULLs ni ceros en ninguna unidad (V15). Únicas excepciones: la unidad `COM` completa (213 filas, 0.20% del monto) y un puñado de materiales `CUT`/`KG` de muestra chica muestran el factor inconsistente — impacto marginal (<0.5% del monto total), se dejan como están.

Ya incorporado en `Datos/sql/v1_flujo_producto_dbc.sql` (sección 14) como columna `cantidad_cajas`, disponible solo para "facturado" (no hay campo equivalente confirmado en `sap_VBAP` para "vendido", y `sap_pago` no llega a nivel material para "cobrado").

## 9. Pendientes y riesgos abiertos (internos)

| # | Tema | Detalle |
|---|---|---|
| 1 | Duplicados en el cruce con `dm_cedis` — **acotado a 1 caso** | Medido: de 187 combinaciones almacén+oficina con más de una fila, 151 son duplicados inofensivos (mismo sector repetido) y 36 tienen `sector` ambiguo entre "Huevo (H) y Croqueta (IA)" vs. "Tortilla (A)". Revisado a fondo (12 ago 2026): en 35 de esos 36, `cedis` y `tipo_venta` resultan **idénticos** sin importar qué sector gane el desempate — la ambigüedad no se propaga al resultado, es inofensiva en la práctica. El único conflicto real es almacén `H717` / oficina `0122` (Celaya): según sector, `cedis` cambia entre "Celaya Agustin" (tipo_venta `EXTRAS`) y "Celaya Genaro" (tipo_venta `VTA EN RUTA`) — coincide con los dos comisionistas de Celaya no documentados hasta ahora (ver sección 15.1 punto 5). La pregunta a negocio se reduce a este único caso (ver sección 15.2 punto 9 actualizado); `dim_cedis_v1` sigue con la regla provisional, correcta en 35/36 casos. |
| 2 | DERIVADOS DE GANADO no cruza | Planta DBC1 / almacén DG01 no encontró registro en `dm_cedis`. |
| 3 | Campo de importe oficial en facturado | Confirmar cuál columna de monto es "lo facturado" ante Hacienda. |
| 4 | Calidad de fechas | `billing_date` con años inválidos (2201, 2202) — filtrar rango razonable. |
| 5 | Datasets por explorar — **resuelto (permisos)** | `D40_EDW`, `D60_REPORTING`, `D62_STREAMLIT` ya listan con la cuenta `quantrue1@proan.com` — era tema de permisos, ya no aplica. Revisados (12 ago 2026): `D60_REPORTING`/`D62_STREAMLIT` son de Maka/Hidrocarburos y de un programa de lealtad (`MSJ_*`), sin relación con DBC/comisiones (excepción revisada: `PRECIOS_AMPLIADO` es detección de anomalías de precio en vivo con ventana de ~30 días, no explica el gap de la sección 4.3). `D40_EDW` tiene tablas `edw_*` de facturación/pago — dos (`edw_billing_header_payment`, `edw_billing_items_payment`) están completamente vacías; `edw_status_billing_payment` tiene `status_payment`/`clearing_dt` en NULL en el 100% de sus filas (las 22 compañías del dataset, no solo DBC) — no sirve para "cobrado". `edw_header_billing_model_cedis` es una alternativa a nivel documento (no línea) para "facturado", monto en el mismo orden de magnitud (+3.3%) que la vista actual — no aporta nada nuevo, se descarta como fuente alterna. |
| 6 | Proxy de SET por texto — **descartado** | Probado en división Huevo: 32.6% sin clasificar, "Rancho" con 0 matches, marca "Campiña" no contemplada. No es viable ni como interino (ver sección 5). Se avanza con SET como dimensión pendiente/nula hasta GS03. |
| 7 | Conversión a CJ | **Resuelto** — ver sección 8. `stockkeeping_units` (facturado) es la cantidad ya convertida a caja, validado con datos reales; ya incorporado como `cantidad_cajas` en `v1_flujo_producto_dbc.sql`. Excepción de bajo impacto (<0.5% del monto) en `COM`/algunos materiales `CUT`/`KG`. |
| 8 | Validar traspasos vía `sap_mseg` — **intentado, inconcluso** | Probado (12 ago 2026) contra el único ejemplo real de MB51 disponible (Sociedad `PAN`, Centro `PANF`, Almacén `H701`, semana 19-25 jul 2025, total `344,102.52`). Ninguna combinación de tipo de movimiento (`BWART`) disponible en `sap_mseg` para ese centro/almacén/semana reproduce el total, ni en cantidad (cajas) ni en importe — se probó el candidato lógico `301/S` (traspaso recibido) sin éxito. No es evidencia en contra de `sap_mseg`: falta que el cliente confirme qué código(s) `BWART` usa su MB51 para "traspasos" (nueva pregunta, sección 15.2 punto 7). Nota de alcance: el ejemplo es de compañía `PAN`, no `DBC` (sección 2). |
| 9 | Facturas repartidas entre 2 almacenes — **medido, bajo impacto** | Confirmado con datos reales: hay `billing_document` con mismo centro y oficina pero 2 `storage_location` distintos. Medido (12 ago 2026): solo 18 de 193,516 `billing_document` DBC (2026) tienen líneas en más de un almacén — 0.11% del monto total ($2.17M de $1,965M). `v1_flujo_producto_dbc` hoy reparte esto con una regla provisional (se queda con un almacén al heredar el sitio para "cobrado") — sigue pendiente que el negocio confirme cómo repartir, pero el impacto en las cifras agregadas es marginal mientras tanto. |
| 10 | Precisión de monto en `v1_flujo_producto_dbc.sql` | `amount_mxn` es `NUMERIC` en `sap_2lis_13_vditm_billing_document_item` (confirmado vía `INFORMATION_SCHEMA`, 12 ago 2026), pero el SQL v1 lo castea a `FLOAT64` en la rama "facturado" — pérdida de precisión evitable en un monto que alimenta comisión. No corregido (el SQL validado no se toca sin necesidad) — señalado para cuando se revise el SQL. |
| 11 | Proxy de SET por `PRODH` (jerarquía SAP) — **descartado** | Revisado (12 ago 2026) como alternativa al proxy por texto ya descartado (sección 5). `PRODH` existe (solo en snapshots diarios `D00_SANDBOX.proan_2LIS_13_VDITM_*`, no en la tabla principal), pero no separa las marcas: el código `0000400001` mezcla materiales "SAN JUAN" y "PORTALES" en división Huevo. Parece agrupar por formato/presentación, no por marca comercial. Confirma que no hay atajo dentro de BigQuery — GS03 sigue siendo el único bloqueante real. |
| 12 | Módulo de conciliación — estructura viable, falta maestro de proveedores — **corregido 1 sep 2026, ver sección 7** | `sap_bsik_open_items` (`D30_INTEGRATION`) tiene la estructura esperada de `FBL1N`. El maestro de proveedores con nombre sí existe (`D20_DIMENSION.dm_vendors`) — no era un tema de que faltara la tabla, sino de que el nombre del comisionista en las tablas del cliente casi nunca cruza exacto contra ella. Universo de proveedores por división manejable (7-155, no miles) pero mezclado con proveedores normales. Detalle en la sección 7 de este documento y en `Datos/Comisiones_DBC_Borrador_Tecnico.md` sección 16.3. |

## 10. Preguntas pendientes para el cliente

1. **Export de GS03** con la definición de los SETs de producto (marca/línea → materiales) para cada división.
2. **Tabla oficial de tarifas de comisión** (TX `ZSDFI_001`) — por ahora solo tenemos tarifas derivadas empíricamente de los reportes (sección 6.1), no la fuente oficial.
3. **Relación comisionista ↔ oficinas de venta**, con nombre — el cliente mismo lo marca como pendiente en su reporte.
4. **Rango de número de proveedor** que identifica comisionistas en SAP, y su **frecuencia de liquidación** (semanal/mensual).

_Ver sección 15 para el estado consolidado de estas preguntas (qué ya contestó el cliente, qué falta) y la lista actualizada de dudas a futuro._

## 11. Propuesta de arquitectura (borrador)

**Capa de datos:** vista (o tabla materializada, refrescada diariamente) en BigQuery que una las cuatro fases — traspasos, vendido, facturado, cobrado — con los catálogos de división, canal, CEDIS/tipo de venta y la tabla de reglas de comisión (sección 6.2). Dejar explícito que el monto de "vendido" es indicativo y que la clasificación por SET (sección 5) es una aproximación temporal.

**Capa de consulta:** MVP rápido con dashboard conectado a la vista para validar con usuarios reales, y eventualmente la plataforma dedicada con los tres módulos del objetivo detallado (flujo de producto, comisiones, conciliación documental) y exportación a máximo detalle.

## 12. Próximos pasos

- Enviar al cliente las preguntas actualizadas de la sección 15.2 (incluye la nueva sobre `BWART` y la acotada de la oficina `0122`).
- Traspasos: validación con `sap_mseg` intentada y sin éxito (sección 4.0) — bloqueada hasta que el cliente confirme el código `BWART` de su MB51.
- Proxy de SET por texto y por `PRODH` descartados (sección 5) — construir el pipeline con SET como dimensión pendiente/nula hasta que llegue GS03.
- Confirmar con negocio la causa exacta del gap de precio en "vendido" (sección 4.3) — no bloqueante.
- Resolver pendientes internos que no dependen del cliente (#2, #3, #4, #10 de la sección 9).
- Con eso, construir la vista de datos definitiva (4 capas + reglas de comisión) y un primer prototipo de consulta.

## 13. Estado frente al objetivo (resumen ejecutivo)

### 13.1 Por módulo del objetivo detallado

| Módulo del objetivo | Qué tenemos | Brecha principal |
|---|---|---|
| Dashboard por CEDIS (flujo de producto) | 3 de 4 capas resueltas y validadas (vendido, facturado, cobrado); traspasos identificado, intento de validación sin éxito. División, canal, CEDIS y tipo de venta resueltos (92.5-100%). | Traspasos sin validar contra `MB51` — falta que el cliente confirme el código `BWART` (sección 4.0). Datasets `D40/D60/D62` ya explorados (sección 9, pendiente #5) — no aportaron un atajo. |
| Comisión y compensación | Estructura de tarifa entendida y validada con datos reales del cliente ($/caja por SET × CEDIS × oficina); tabla de reglas configurable diseñada; medida de "compensado" alineada al objetivo (`sap_pago.clearing_date`); confirmado que no hay atajo en BigQuery para el SET (`PRODH`/tablas `SETLEAF` descartados, sección 5). | Sin el mapeo material→SET no se puede calcular ninguna comisión real todavía — es el bloqueante único de este módulo. Falta también la tarifa oficial (`ZSDFI_001`) y la agrupación comisionista↔oficinas (acotada casi del todo a la oficina `0122`, sección 15.1 punto 5). |
| Conciliación documental (SAT) | Fuente candidata identificada y explorada (`FBL1N` → `sap_bsik_open_items`) — estructura confirmada viable. | Falta el rango de proveedor que identifica comisionistas: no existe maestro de proveedores con nombre en BigQuery, depende de la respuesta del cliente (pendiente #12, sección 9). |

### 13.2 Granularidad de categorización

- **División, CEDIS, tipo de venta:** resuelto, listo para producción (92.5-100% de cobertura).
- **Producto:** aquí hay una distinción importante. Para el **dashboard** (objetivo: "detalle a tipo de producto y presentación"), ya tenemos más granularidad de la pedida — `material_number` individual, más fino que el SET. Para la **comisión**, en cambio, se necesita agrupar por SET (marca/línea), y ese mapeo no existe todavía sin GS03 — el proxy por texto quedó descartado. Es decir: podemos mostrar el detalle máximo en el dashboard hoy, pero no podemos calcular comisión real hasta tener el mapeo material→SET.

### 13.3 Granularidad temporal

- Vendido, facturado y cobrado ya tienen fecha a nivel transacción (`ERDAT`/`AUDAT`, `billing_date`, `clearing_date`) y se pueden refrescar a diario, alineado con el objetivo de "reflejar diario el estatus de cada operación". Traspasos, en principio, también (`MB51`/`sap_mseg`), pendiente de validar.
- Periodicidad de pago de comisión (semanal/mensual según comisionista) queda cubierta por el diseño de la tabla de reglas (`vigente_desde`/`vigente_hasta`), pero para aplicarla por comisionista específico falta la agrupación oficinas↔comisionista.
- El alcance desde enero 2026 no choca con ninguna limitación de historia de datos encontrada.

### 13.4 Lectura general

El modelo de datos (4 capas), la estructura de tarifa y el diseño de reglas están validados contra reportes reales del cliente — la arquitectura de fondo está alineada con el objetivo. Lo que falta para completar los 3 módulos no es diseño ni exploración de datos propios, es **información que solo puede dar el cliente**: GS03 (SETs), `ZSDFI_001` (tarifa oficial), comisionista↔oficinas (ya acotado a un caso puntual, la oficina `0122`), rango de proveedor/frecuencia, y el código `BWART` de su MB51 para traspasos. Conciliación documental (módulo 3) y traspasos ya se exploraron a fondo (secciones 4.0, 7 y 9) — la estructura es viable en ambos casos, lo que falta en los dos es información del cliente, no más trabajo de datos propio.

## 14. v1 de datos — vista de flujo de producto

Primera versión de la capa de datos propuesta en la sección 11, ya escrita como SQL: [`Datos/sql/v1_flujo_producto_dbc.sql`](./sql/v1_flujo_producto_dbc.sql).

Une vendido + facturado + cobrado (las 3 capas ya resueltas y validadas de la sección 4) en una sola vista `v1_flujo_producto_dbc` (un renglón por evento, columna `fase` para distinguir), más una vista agregada `v1_flujo_producto_dbc_resumen_diario` (por fecha × división × CEDIS × tipo_venta × fase) lista para KPIs. Deja fuera a propósito traspasos (sin validar contra `MB51`, pendiente #8) y el SET de producto (bloqueado por GS03, sección 5) — expone `material_number` en su lugar, que ya alcanza para el detalle de producto del dashboard. Incluye `cantidad_cajas` (solo en "facturado" — sección 8, pendiente #7 resuelto), la cantidad ya normalizada a caja, lista para cruzarse contra la tarifa $/caja de la sección 6.1 en cuanto exista el mapeo a SET.

Incluye también `dim_cedis_v1`, que resuelve el fan-out de la sección 9 (pendiente #1) con una regla de desempate provisional (primer sector en orden alfabético) — ajustar cuando el negocio defina la regla real.

**Sin validar contra BigQuery real todavía** — se escribió a partir de los nombres de tabla/columna ya documentados en este borrador, pero sin correrlo (sin acceso a BigQuery desde el entorno donde se escribió). Antes de conectarlo al dashboard: correr el script, confirmar nombres de columna exactos (marcados con TODO en el archivo) y ajustar tipos si hace falta.

## 15. Dudas al cliente — estado consolidado

Consolida en un solo lugar el correo ya enviado al cliente (`Dudas Senior a cliente (a tener en cuenta).md`) contra lo que sus 6 excels de ejemplo (semana 19-25 jul 2025: `DBC-BO`, `DBC-IA`, `DBC-A`, `DBC-H`, `PAN-H`, y el reporte completo de referencia con hojas `Reporte`/`Traspasos`/`Inventarios`/`Comision`) ya contestaron, y lo que sigue abierto. Sustituye la necesidad de reconstruir esto cada vez — las secciones 3-10 tienen el detalle de origen de cada hallazgo.

### 15.1 Estado de las 6 preguntas del correo

| # | Tema | Estado | Detalle |
|---|---|---|---|
| 1 | Relación centro-almacén por CEDIS (todas las divisiones) | **Parcial** | Los reportes recibidos solo cubren las 4 divisiones de DBC (H, BO, A, IA) — nada de L, DG, CE, CP, CM. Para esas 4 ya lo tenemos resuelto por cuenta propia vía `dm_cedis` (~92.5% cobertura, sección 3). Hueco conocido sin resolver: planta `DBC1`/almacén `DG01` no cruza con `dm_cedis` (pendiente #2, sección 9) — posible "Derivados de Ganado" de DBC sin mapear. |
| 2 | Oficinas de venta (clave + nombre) | **Resuelto — por cuenta propia** | El cliente no lo respondió (su columna de oficina viene vacía, marcada "PENDIENTE NOMBRE OFICINA DE VENTAS"). Lo resolvimos solos con `D00_SANDBOX.proan_TVKBT_20260728` (VKBUR+BEZEI), más completo que lo que tiene el propio cliente (sección 3). |
| 3 | Transacción/ejemplo de compensados (la que usaba Alejandro) | **Resuelto — por el cliente** | Los excels que mandó SON la respuesta: hoja "Traspasos" con TX `MB51` + ejemplo real de resultado; hoja "Inventarios" con TX `MB5B`; hoja "Comision" con TX `ZSDFI_001`; hoja "Reporte" confirma TX `FBL1N` para la factura del comisionista. No hace falta pedir nada más de este punto. |
| 4 | Tabla de equivalencia unidad↔comisión + categorización de producto | **Parcial** | El cliente confirmó la transacción fuente (`ZSDFI_001`, hoja "Comision"), pero no mandó el export de esa tabla — solo un reporte semanal con tarifas ya calculadas (columnas `COM_*`), de donde derivamos tarifas empíricas $/caja por SET × CEDIS × oficina (sección 6.1), no la fuente oficial. La categorización de producto (SET) sigue sin contestar — depende de GS03 (sección 5). |
| 5 | Identificación del comisionista (rango proveedor, frecuencia, origen CFDIs) | **Parcial** | El reporte de referencia trae nombre del comisionista y su agrupación de oficinas en columnas sin encabezado formal (ej. Martha Leticia → oficina `0019-0092`; Jorge Machain → `0121`; Leon1 → `0005-0071`; Leon2 → `0088-0073`), y confirma `FBL1N` como fuente de la factura — pero el propio reporte marca esa columna "PENDIENTE": ni ellos lo tienen resuelto del todo. Rango de número de proveedor y frecuencia de liquidación: sin respuesta, en ningún documento. **Hallazgos adicionales (12 ago 2026)**, al releer los 6 excels completos: (a) los reportes por división (`DBC- H`, `DBC- BO`, `DBC- IA`) invierten Leon1/Leon2 respecto al reporte de referencia — ahí Leon1 = `0088-0073` y Leon2 = `0005-0071`, al revés — inconsistencia real del propio cliente, no nuestra; (b) dos comisionistas de Celaya no documentados hasta ahora: "Agustin" (`0145-0012-0083`) y "Genaro" (`0122`); (c) cruzando contra `dm_cedis` en BigQuery, la oficina `0122` (almacén `H717`) es el único caso real de los 36 de la sección 9 pendiente #1 — parece estar compartida entre Agustin y Genaro según `tipo_venta` (`EXTRAS` vs. `VTA EN RUTA`). Vale la pena preguntar directo por este caso puntual en el próximo correo. |
| 6 | Inventarios (¿se consultan al día desde centro-almacén?) | **Resuelto — por el cliente** | Confirmado vía TX `MB5B`, misma estructura centro-almacén. Fuera de alcance por ahora (sección 1), pero técnicamente contestado. |
| 7 | "¿Nos falta algo?" | **Sin respuesta** | No hay nada en ningún documento — sigue siendo pregunta abierta. |

### 15.2 Dudas a futuro (para el próximo correo/reunión)

Reemplaza la lista de la sección 10, con el detalle ya afinado:

1. **Export real de GS03** (SETs de producto por división) — igual que antes, nada nuevo.
2. **Export real de la tabla `ZSDFI_001`** — ya sabemos que es la transacción correcta (lo confirmó el cliente en su propio reporte); lo que falta es el dato en sí, no el nombre de la fuente.
3. **Agrupación comisionista ↔ oficinas de venta, completa y confirmada** — tenemos ejemplos parciales del reporte de referencia (sección 15.1, punto 5), pero el cliente mismo la marca como pendiente; hace falta la tabla completa y confirmada, no solo estos casos.
4. **Rango de número de proveedor** que identifica comisionistas en SAP, y su **frecuencia de liquidación** (semanal/mensual) — sin ninguna pista todavía.
5. **Confirmar si L, DG, CE, CP, CM aplican a DBC** en algún CEDIS/almacén, o si son de otras empresas del grupo y quedan fuera de alcance — los reportes recibidos solo cubren H/BO/A/IA.
6. **Resolver el cruce faltante `DBC1`/`DG01`** contra `dm_cedis` — posible "Derivados de Ganado" de DBC no mapeado (pendiente #2, sección 9).
7. **Qué código(s) de tipo de movimiento (`BWART`) usa el cliente en su MB51 para "traspasos"** — se intentó validar `sap_mseg` contra el ejemplo real de MB51 (Sociedad PAN, Centro PANF, Almacén H701, semana 19-25 jul 2025) sin éxito: ninguna combinación de `BWART` disponible en `sap_mseg` reproduce el total. Sin saber qué código usa el cliente, no se puede completar la validación (pendiente #8, sección 9).
8. **Repetir "¿nos falta algo?"** — nadie la ha contestado todavía.
9. **Cómo repartir la oficina `0122` (almacén `H717`, Celaya) entre "Agustin" y "Genaro"** — acotado de 36 casos a 1 solo (pendiente #1, sección 9): revisando `dm_cedis` a fondo, en los otros 35 casos la ambigüedad no cambia el resultado (`cedis`/`tipo_venta` salen iguales sin importar el desempate). Este caso sí cambia ambos según cómo se resuelva — es la única decisión de negocio real que falta aquí, no 36.
10. **Cómo repartir el monto cobrado de facturas que abarcan 2 almacenes** — confirmado con datos reales (pendiente #9, sección 9); mismo tipo de decisión que el punto 9, para la rama "cobrado". Impacto medido: 0.11% del monto total (18 de 193,516 facturas) — bajo, pero pendiente.

### 15.3 Cobertura real de `v1_flujo_producto_dbc` (corrida final v1)

Cifras vigentes, ya con los dos fixes de la rama "cobrado" aplicados: `company_code = 'DBC'` directo sobre `sap_pago` (en vez de heredarlo del match con la factura), y `document_category = 'M'` (V7/V8 de `v1_verificaciones.sql`) para excluir compensaciones/ajustes internos sin factura asociada (26,311 filas, $0, ver sección 9 y `Datos/sql/v1_flujo_producto_dbc.sql`).

| Fase | Filas | Monto total | Rango de fechas | Filas sin CEDIS resuelto |
|---|---|---|---|---|
| Vendido | 1,506,006 | $1,867,026,840.65 | 2026-01-01 a 2026-07-20 | 87,472 (5.8%) |
| Facturado | 1,745,163 | $1,903,510,061.80 | 2026-01-01 a 2026-08-02 | 121,406 (7.0%) |
| Cobrado | 51,763 | $1,758,736,858.44 | 2026-01-02 a 2026-07-31 | 12,822 (24.8%) |

El hueco de CEDIS en vendido/facturado (~6-7%) es consistente con la cobertura de `dm_cedis` ya documentada en la sección 3 (~92.5%). El de cobrado bajó de un pico intermedio de 50.2% (39,203 de 78,146, cuando el filtro de `company_code` ya estaba directo pero `document_category` todavía no) a 24.8% — ahora consistente con el resto del flujo, y también con el 75% de cobertura ya documentado en la sección 3 para "Momento de cobro" (son la misma relación medida en direcciones opuestas: aquí es pago→CEDIS heredado de la factura, allá es facturado→pago). El monto total no cambió en ningún punto de este proceso ($1,758,736,858.44 en las tres corridas), confirmando que las filas descartadas en cada fix nunca representaron dinero real, solo movimientos contables sin sitio/factura asociados.
