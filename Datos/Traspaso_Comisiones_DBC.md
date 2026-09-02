# Traspaso — Comisiones DBC

_Preparado para dar continuidad al proyecto mientras Silvana está fuera. Fecha: 7 de agosto de 2026._

> **Superado — 1 de septiembre de 2026.** Este traspaso cumplió su función; casi
> todo lo que marca como "falta" (GS03, `ZSDFI_001`, agrupación comisionista↔oficinas)
> se resolvió entre el 24 de agosto y hoy. Para el estado actual, ir directo a
> `Datos/Comisiones_DBC_Borrador_Tecnico.md`, sección 16. Se deja el resto del
> documento sin tocar como registro de en qué punto estaba el proyecto en esa fecha.

## Qué es el proyecto

Plataforma para DBC (distribuidor del grupo Proan) que consolida datos de SAP (vía BigQuery) para dar visión del flujo de producto por CEDIS — traspasos → vendido → facturado → cobrado —, calcula la comisión de los comisionistas (se paga solo sobre lo efectivamente cobrado) y concilia las facturas de los comisionistas contra sus pagos para cumplimiento SAT.

## Dónde está todo

- **Repo:** `C:\Dev\proan-dbc-comisiones`.
- **Documento técnico vivo:** `Datos/Comisiones_DBC_Borrador_Tecnico.md` — todo el detalle de hallazgos, decisiones y pendientes está aquí, organizado por sección. Es la fuente de verdad; si algo no cuadra con este resumen, manda ese documento.
- **SQL de datos:** `Datos/sql/v1_flujo_producto_dbc.sql` (la vista consolidada, ya validada) y `Datos/sql/v1_verificaciones.sql` (bitácora de todas las queries de verificación corridas y sus resultados — útil para entender el porqué de cada decisión en el SQL).
- **Frontend:** `apps/frontend` — mockup de los 3 módulos (flujo de producto, comisiones, conciliación) ya conectado a la API real (bloqueada en 501 donde falta información del cliente).

## Qué llevamos (resuelto y validado con datos reales)

- Modelo de 4 capas confirmado: traspasos, vendido, facturado, cobrado. Las 3 últimas ya están resueltas y corriendo en BigQuery (`v1_flujo_producto_dbc`):

  | Fase | Filas | Monto | Sin CEDIS resuelto |
  |---|---|---|---|
  | Vendido | 1,506,006 | $1,867,026,840.65 | 5.8% |
  | Facturado | 1,745,163 | $1,903,510,061.80 | 7.0% |
  | Cobrado | 51,763 | $1,758,736,858.44 | 24.8% |

- Dimensiones resueltas: división de producto (100%), canal (100%), CEDIS + tipo de venta (~92.5%).
- Conversión de unidades a caja (CJ) resuelta: el campo `stockkeeping_units` de facturado ya trae la cantidad convertida a caja (validado contra miles de filas por material) — está incorporado como `cantidad_cajas` en el SQL.
- Estructura real de la tarifa de comisión entendida: importe fijo **$/caja**, varía por SET × CEDIS × oficina (derivada empíricamente de los reportes del cliente, no es la fuente oficial todavía).
- Diseño de tabla de reglas de comisión configurable (SET/CEDIS/oficina/tipo de venta opcionales + vigencia).

## Qué falta

**Depende del cliente (no es algo que podamos resolver con más SQL):**
- Export de **GS03** (SETs de producto) — bloqueante único para calcular comisión real.
- Export de la tabla oficial de tarifas **ZSDFI_001**.
- Agrupación completa **comisionista ↔ oficinas de venta**.
- Rango de proveedor + frecuencia de liquidación de comisionistas.
- Confirmar alcance de divisiones L/DG/CE/CP/CM y el cruce DBC1/DG01.

**Internos, no bloqueantes:**
- Validar `sap_mseg` contra `MB51` para la capa de traspasos (ya hay un ejemplo real de MB51 en el reporte del cliente para usar de caso de prueba).
- Explorar los datasets `D40_EDW`, `D60_REPORTING`, `D62_STREAMLIT` (no se pudo listar su contenido — puede ser tema de permisos).
- Módulo de conciliación documental (SAT): casi sin explorar. Candidata: `sap_bsik_open_items` (vía `FBL1N`).

## Dos decisiones de negocio pendientes

1. 36 combinaciones de almacén+oficina que hoy mapean a dos sectores a la vez ("Huevo/Croqueta" vs. "Tortilla") — el SQL hoy usa una regla arbitraria provisional (primer sector alfabético) mientras se confirma.
2. Facturas que abarcan 2 almacenes distintos — mismo tema, para la rama "cobrado".

**No aplicar ningún cambio a estas dos reglas sin que el cliente/negocio confirme explícitamente cómo repartir.**

## Notas para quien continúe

- El SQL de vendido/facturado/cobrado ya está cerrado y validado — no debería tocarse salvo que aparezca un error nuevo al correrlo.
- Todo el trabajo de verificación sigue un mismo patrón: antes de "corregir" algo basado en un supuesto, se agrega la query correspondiente a `v1_verificaciones.sql`, se corre en BigQuery (no hay acceso directo a BigQuery desde este entorno de trabajo), y solo se aplica el cambio con los resultados reales en mano — evitar saltarse este paso.
- Si llega respuesta del cliente sobre GS03, ZSDFI_001, comisionistas o cualquiera de los pendientes de arriba, actualizar la sección 15 del borrador técnico con el hallazgo.
