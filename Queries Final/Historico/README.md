# Histórico · carga completa

`CREATE OR REPLACE TABLE` — cada archivo recalcula su tabla entera desde cero. Se corren a
mano: para la primera carga en el dataset definitivo, o cuando haya que rehacer el histórico.

**Aquí vive la lógica de negocio.** Todos los comentarios largos (de dónde sale cada
columna, por qué ese filtro, qué se midió para decidirlo) van en estos archivos. Los de
`../Airflow/` remiten aquí y solo explican su recorte incremental.

**Antes de tocar nada, lee la regla de los gemelos en [`../README.md`](../README.md).** Si
cambias columnas, orden de columnas o el `SELECT` final de un archivo de aquí, hay que
cambiar su gemelo de `../Airflow/` **en el mismo commit**.

## Precondición que no es un `.sql`

`D20_DIMENSION/` no tiene archivo para `dm_DBC_comisionista` ni `dm_DBC_almacen_nombre`:
esas dos salen del Excel del cliente vía `scripts/tablas_cliente.py --cargar`, que es Python,
no SQL. Es carga manual estática y el cliente no ofreció otra alternativa. Tiene que haber
corrido antes que cualquier cosa de `D50_AGGREGATE/`.

## Coste

Reconstruir la cadena completa escanea ~34 GB, unos **$0,17 por corrida**. No es caro; el
incremental de `../Airflow/` existe por el volumen futuro, no porque esto sea prohibitivo.
