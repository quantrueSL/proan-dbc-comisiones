# Queries Final · Comisiones DBC

SQL definitivo del pipeline, ya apuntando a los datasets destino (`D20_DIMENSION`,
`D50_AGGREGATE`, `D60_REPORTING`) en vez de a `ZZ_PRUEBAS`.

Dos ramas, **una por cada forma de correr la misma consulta**:

| | qué hace | cuándo corre |
|---|---|---|
| **`Historico/`** | `CREATE OR REPLACE TABLE` — recalcula la tabla entera desde cero | a mano: primera carga, o cuando haya que rehacer el histórico |
| **`Airflow/`** | `DELETE` + `INSERT` acotado a una ventana | a diario, orquestado en el DAG |

Toda la **lógica de negocio y sus comentarios largos viven en `Historico/`**. Los archivos
de `Airflow/` remiten a su gemelo y solo explican el recorte incremental. Misma convención
que `proan-maka-rentabilidad` (`ConsultasBigQuery/` ↔ `Airflow/`), con una diferencia: aquí
las dos ramas tienen **la misma estructura de carpetas por dataset**, para que cada gemelo
esté en la ruta espejo de su par.

> ## ⚠ La regla de los gemelos
>
> **Tocar un `.sql` de `Historico/` obliga a tocar su gemelo de `Airflow/` en el mismo commit.**
>
> El `INSERT INTO` de `Airflow/` es **posicional**: no nombra columnas, van por orden. Si las
> dos versiones se desincronizan pasa una de dos cosas:
>
> - el número de columnas ya no coincide → el DAG falla con `Inserted row has wrong column
>   count`. Molesto, pero se ve.
> - el número coincide y **el orden no** → escribe datos mal, en silencio, sin error.
>
> Esto tumbó el DAG de Rentabilidad MAKA 6 días en julio de 2026 por el primer caso. El
> segundo es el que da miedo.

## Estructura

```
Queries Final/
├─ Historico/
│  ├─ D20_DIMENSION/     dm_DBC_base_comision_v1
│  ├─ D50_AGGREGATE/     v1_flujo_producto_dbc · DBC_silver_flujo_producto · DBC_comisiones_calculadas_cobro
│  └─ D60_REPORTING/     5 gold + dm_DBC_periodo_pago
└─ Airflow/
   ├─ D50_AGGREGATE/     2 gemelos
   └─ D60_REPORTING/     5 gemelos
```

**`Airflow/` no tiene `D20_DIMENSION`** y es correcto: de esa capa, dos tablas
(`dm_DBC_comisionista`, `dm_DBC_almacen_nombre`) salen del Excel del cliente por carga
manual y la tercera es una vista. Nada que refrescar a diario. Si algún día alguna de esas
dimensiones pasa a construirse desde SAP, ahí se crea la carpeta.

## Inventario y patrón de carga

`ventana_desde` es una `DECLARE` con **el mismo valor en los 7 archivos de Airflow**:
los últimos 12 meses completos.

| Histórico | Airflow | partición | ventana |
|---|---|---|---|
| `D20/dm_DBC_base_comision_v1.sql` | — | vista | — |
| `D50/v1_flujo_producto_dbc.sql` | — | vista | — |
| `D50/DBC_comisiones_calculadas_cobro.sql` | ✔ | `billing_date` | `>= ventana_desde` |
| `D50/DBC_silver_flujo_producto.sql` | ✔ | `fecha` | `>= ventana_desde` |
| `D60/DBC_gold_comision_diaria_v2.sql` | ✔ | `fecha` | `>= ventana_desde` |
| `D60/DBC_gold_flujo_producto_diario.sql` | ✔ | `fecha` | `>= ventana_desde` |
| `D60/DBC_gold_conciliacion_factura_linea.sql` | ✔ | `fecha` | `>= ventana_desde` |
| `D60/DBC_gold_conciliacion_producto_diario.sql` | ✔ | `fecha` | `>= ventana_desde` |
| `D60/DBC_gold_conciliacion_pago_semanal.sql` | ✔ | `periodo` | `>= ventana_desde` |
| `D60/dm_DBC_periodo_pago.sql` | — | vista | — |

**Por qué 12 meses y no 3.** El cobro llega tarde: medido sobre las compensaciones de 2026,
solo el **43% del dinero se cobra en los primeros 7 días**, el 12% llega después de 90 y el
3% después de 180. Una ventana de 90 días perdería cobros reales. Y como la silver recalcula
`se_cobro`/`monto_cobrado` sobre facturas viejas, la ventana tiene que cubrir esa cola.

**Por qué la ventana del gold nunca puede ser menor que la de la silver:** si lo fuera, el
gold conservaría filas que la silver ya no tiene. De ahí el valor único compartido.

**Las vistas no tienen gemelo.** Una vista no se materializa, así que no hay nada que
refrescar a diario: basta con que el DDL se haya corrido una vez.

## Orden de ejecución

```
0  precondición (manual)   scripts/tablas_cliente.py --cargar
                           → dm_DBC_comisionista · dm_DBC_almacen_nombre
1  vistas (una sola vez)   dm_DBC_base_comision_v1 · v1_flujo_producto_dbc · dm_DBC_periodo_pago

2  silver (en paralelo)    DBC_comisiones_calculadas_cobro
                           DBC_silver_flujo_producto

3  gold (en paralelo)      DBC_gold_comision_diaria_v2          ← silver comisiones
                           DBC_gold_conciliacion_factura_linea  ← silver comisiones
                           DBC_gold_conciliacion_pago_semanal   ← silver comisiones + BSAK
                           DBC_gold_flujo_producto_diario       ← silver flujo

4  gold ← gold             DBC_gold_conciliacion_producto_diario ← gold_conciliacion_factura_linea
```

El paso 4 es la trampa: `producto_diario` no sale de la silver sino de otra gold, así que
tiene que correr **después** de que `factura_linea` haya recargado su ventana, no en paralelo.

`v1_flujo_producto_dbc` lee `dm_DBC_comisionista` (desempate de Celaya, 2026-09-24), así que
el paso 0 es precondición también de la rama de flujo, no solo de la de comisiones.

## Fuentes: qué se refresca solo y qué no

| fuente | estado |
|---|---|
| `D30_INTEGRATION.sap_2lis_13_vditm_billing_document_item` | viva, al día |
| `D30_INTEGRATION.sap_bsad_cleared_items` | viva, al día |
| `D00_SANDBOX.RT_BSAK` + `proan_BSAK_20260708` | viva; la consulta une las dos. Hueco real del 9 al 31 de julio de 2026. El pago se mide con `QSSHB` (base sin IVA/retenciones), no `DMBTR` (neto, = base × 1.0533) |
| `D00_SANDBOX.proan_MAKT_Materials_*` | serie diaria → leer con `MAX(_TABLE_SUFFIX)` |
| `D10_POSTPROCESSING.sap_MARM_*` | serie diaria → leer con `MAX(_TABLE_SUFFIX)` |
| `D00_SANDBOX.sap_setleaf_comisiones` | tabla única sin sufijo, nada que parametrizar |
| `D00_SANDBOX.proan_ZTSD_OV_COM_*_20260829` | **foto única congelada** — la única que depende de que el cliente mande una nueva |

La tarifa se queda fija a propósito. Conviene un check que avise cuando esa foto pase de X
días, o el DAG usará la de agosto para siempre sin que nadie se entere.

## Estado

Nada migrado todavía. Estos `.sql` apuntan a los datasets definitivos, pero lo que leen los
tres engines sigue siendo `ZZ_PRUEBAS` hasta que se corra la migración y se repunten las
constantes `_TABLA_*` de `comisiones_engine.py`, `conciliacion_engine.py` y `flujo_engine.py`.
