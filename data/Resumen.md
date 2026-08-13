# Resumen de datos — Comisiones DBC

_12 de agosto de 2026. README de la carpeta `data/` — trabajo de datos hecho en paralelo al `Datos/` de Silvana, sin tocar ese material._

## De qué va esto

DBC (distribuidor del grupo Proan) recibe producto y lo distribuye vía sus CEDIS. Por cada venta cobra una comisión a comisionistas, pagadera solo sobre lo **efectivamente cobrado** (no sobre lo vendido). El proyecto: dashboard del flujo de producto por CEDIS, cálculo de esa comisión, y conciliación documental de las facturas de los comisionistas contra sus pagos (para SAT).

Todo vive en BigQuery, proyecto `proan-quantrue` (región `us-west4`), compartido con el resto del grupo. Filtro maestro: `company_code = 'DBC'`. Alcance temporal: desde enero 2026.

## Modelo de datos: 4 capas

| Fase | Fuente BigQuery | Estado |
|---|---|---|
| Traspasos (entrada a CEDIS) | `D30_INTEGRATION.sap_mseg` | Sin validar — bloqueado, ver preguntas |
| Vendido | `sap_VBAK` + `sap_VBAP` | Resuelto y validado |
| Facturado | `sap_2lis_13_vditm_billing_document_item` | Resuelto |
| Cobrado / compensado | `D50_AGGREGATE_CHATBI.sap_pago` | Resuelto |

Vendido, facturado y cobrado ya están unidos en una sola vista SQL (`Datos/sql/v1_flujo_producto_dbc.sql`, de Silvana — validado, no tocar). Cobertura de la última corrida:

| Fase | Filas | Monto | Rango de fechas | Sin CEDIS resuelto |
|---|---|---|---|---|
| Vendido | 1,506,006 | $1,867,026,840.65 | 2026-01-01 a 2026-07-20 | 5.8% |
| Facturado | 1,745,163 | $1,903,510,061.80 | 2026-01-01 a 2026-08-02 | 7.0% |
| Cobrado | 51,763 | $1,758,736,858.44 | 2026-01-02 a 2026-07-31 | 24.8% |

## Qué tenemos resuelto

- **División de producto** (`sales_division` → `D20_DIMENSION.dm_business_area`): 100% cobertura. `H`=Huevo, `BO`=Botana, `A`=Abarrote, `IA`=Alimento.
- **Canal de distribución**: 100% cobertura.
- **CEDIS + tipo de venta** (`storage_location`+`sales_office` → `D20_DIMENSION.dm_cedis`): ~92.5% cobertura. Tipos: VTA EN RUTA, MAYOREO, MED MAYOREO, EXTRAS.
- **Conversión a caja (CJ)**: `stockkeeping_units` (en facturado) da la cantidad ya convertida, validada contra miles de filas. Incorporada como `cantidad_cajas`.
- **Estructura de la tarifa de comisión**: importe fijo $/caja, varía por SET × CEDIS × oficina (derivada empírica de los reportes del cliente — no es la fuente oficial todavía). Ejemplo: San Juan en León 1/Querétaro/Salamanca = $1.50/caja, en Uruapan = $2.15/caja.
- **Nombre de oficina de venta** (`D00_SANDBOX.proan_TVKBT_20260728`): más completo que lo que tiene el propio cliente.

## Lo que se descartó esta sesión (para no reinvestigar)

Con acceso completo a BigQuery (`quantrue1@proan.com`, antes bloqueado por permisos):

- **`SETLEAF`/`SETHEADER`/`SETNODE`/`GS01`/`GS02`/`GS03`/`ZSDFI`**: no existen en ningún dataset del proyecto. Confirmado, no es tema de permisos.
- **`PRODH`** (jerarquía de producto SAP): existe (solo en snapshots diarios `D00_SANDBOX.proan_2LIS_13_VDITM_*`), pero mezcla marcas distintas en el mismo código (ej. San Juan y Portales juntos en división Huevo) — no sustituye a GS03.
- **`D40_EDW`**: tablas `edw_billing_header_payment`/`edw_billing_items_payment` están vacías (0 filas); `edw_status_billing_payment` tiene sus columnas de pago (`status_payment`, `clearing_dt`) en NULL el 100% del tiempo — no sirve para "cobrado". `edw_header_billing_model_cedis` es una alternativa a nivel documento (no línea) para "facturado", sin aportar nada nuevo.
- **`D60_REPORTING`/`D62_STREAMLIT`**: de Maka/Hidrocarburos y de un programa de lealtad — sin relación con DBC/comisiones. `PRECIOS_AMPLIADO` (detección de anomalías de precio, ventana de 30 días) no explica el gap de precio vendido→facturado.
- **`sap_mseg` vs. `MB51`**: probado contra el único ejemplo real disponible (Sociedad PAN, Centro PANF, Almacén H701, semana 19-25 jul 2025, total 344,102.52) — ninguna combinación de tipo de movimiento (`BWART`) lo reproduce. Inconcluso, no es evidencia contra `sap_mseg` — falta saber qué código usa el cliente.

## Dos "pendientes de negocio" que resultaron ser casi nada

- **36 combinaciones almacén+oficina ambiguas** (dos sectores posibles en `dm_cedis`): revisadas una por una — en 35 de 36 el resultado final (`cedis`, `tipo_venta`) es idéntico sin importar el desempate, es cosmético. Queda **1 solo caso real**: almacén `H717` / oficina `0122` (Celaya), donde sí cambia entre "Celaya Agustin" (tipo_venta EXTRAS) y "Celaya Genaro" (tipo_venta VTA EN RUTA).
- **Facturas repartidas entre 2 almacenes**: real, pero solo 18 de 193,516 facturas DBC 2026 (0.11% del monto, $2.17M de $1,965M). Bajo impacto mientras no haya regla de negocio.

## Lo que falta — solo lo puede resolver el cliente

| # | Qué falta | Por qué es necesario |
|---|---|---|
| 1 | Export de **GS03** (SETs de producto por división) | Bloqueante único para calcular comisión real — sin esto no se puede agrupar `material_number` por marca/línea |
| 2 | Export de la tabla oficial de tarifas **`ZSDFI_001`** | Hoy solo hay tarifas derivadas empíricamente de reportes, no la fuente oficial |
| 3 | Cómo repartir la oficina **`0122`** entre "Agustin" y "Genaro" | Único caso real de ambigüedad CEDIS que queda (ver arriba) |
| 4 | **Rango de número de proveedor** de comisionistas + frecuencia de liquidación | `sap_bsik_open_items` ya tiene la estructura lista (proveedor, compensación, importe) pero no hay maestro de proveedores con nombre en BigQuery — no se puede aislar comisionistas del resto de proveedores sin este dato |
| 5 | Qué código(s) **`BWART`** usa el cliente en su MB51 para "traspasos" | Sin esto no se puede validar `sap_mseg` contra el ejemplo real que ya tenemos |
| 6 | Confirmar si **L, DG, CE, CP, CM** aplican a DBC | Los reportes recibidos solo cubren H/BO/A/IA |
| 7 | Cruce faltante **`DBC1`/`DG01`** contra `dm_cedis` | Posible "Derivados de Ganado" de DBC sin mapear |
| 8 | Repetir **"¿nos falta algo?"** | Nadie la ha contestado todavía |

De propina, al releer los 6 excels del cliente: sus reportes por división invierten "Leon1"/"Leon2" respecto al reporte de referencia (inconsistencia del propio cliente, no nuestra) — vale la pena señalarlo también.

## Lo que se puede hacer ya, sin esperar al cliente

- Mandar el correo con las 8 preguntas de arriba — es lo que de verdad desbloquea el resto.
- CI/CD (tests en push a main; deploy se deja para después).
- Backend sin tests; `catalog_engine.py` no maneja errores de BigQuery ni tiene logging; service account de Cloud Run con rol Editor genérico (de la revisión de código, no de este documento de datos).
- Nota técnica de bajo impacto para cuando se retoque el SQL: `amount_mxn` es `NUMERIC` en origen pero `v1_flujo_producto_dbc.sql` lo castea a `FLOAT64` — precisión evitable perdida en un monto que alimenta comisión. No se tocó el SQL validado por esto.

## Dónde está cada cosa

- **`Datos/`** — de Silvana, fuente de verdad, no se toca: `Comisiones_DBC_Borrador_Tecnico.md`, `sql/v1_flujo_producto_dbc.sql`, `sql/v1_verificaciones.sql`.
- **`data/`** (esta carpeta) — trabajo de esta sesión:
  - `Comisiones_DBC_Borrador_Tecnico.md` — copia del borrador con todos los hallazgos de esta sesión ya integrados (secciones 4.0, 5, 7, 9, 12, 13, 15).
  - `sql/` — las ~31 queries de exploración corridas contra BigQuery (todas de solo agregados/esquema, sin datos de cliente).
  - `notas/01` a `06` — el detalle completo de cada hallazgo, uno por archivo.
  - `Resumen.md` — este archivo.
- **`backup/`** (gitignored) — los 6 excels originales del cliente + su conversión a Markdown en `backup/md/`.
