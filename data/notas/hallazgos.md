# Hallazgos de la investigación de datos — Comisiones DBC

_Sesión del 12-13 de agosto de 2026. Consolida en un solo documento lo que
antes eran varias notas sueltas — el detalle de cada hallazgo y, al final, por
qué existen dos consultas propias (`data/consultas/`) distintas de la vista de
Silvana._

Contexto: con la cuenta `quantrue1@proan.com` se obtuvo acceso completo a
BigQuery (antes bloqueado por permisos a varios datasets), lo que permitió
cerrar varias vías que el borrador de Silvana dejaba abiertas, y al construir
las tablas silver/gold del flujo de producto aparecieron dos hallazgos que
afectan directamente al dashboard.

## Los dos hallazgos que importan de verdad

### El corte de `sap_VBAP` desde el 20 de julio de 2026

Detectado al validar la tabla silver contra las cifras ya conocidas de
`Resumen.md`: la fase **vendido** del flujo de producto se corta el
2026-07-20, mientras facturado llega al 2026-08-13 y cobrado al 2026-08-12.

Comparando contra la corrida apuntada un día antes en `Resumen.md`, vendido
reproducía las cifras al céntimo (1.506.006 filas, $1.867.026.840,65) mientras
las otras dos fases seguían creciendo — un cuadre perfecto entre dos corridas
separadas por un día es sospechoso, no tranquilizador: significaba que no
había entrado dato nuevo.

La causa no es la SQL ni el filtro de DBC, es la tabla origen. `sap_VBAK`
(cabeceras) tiene entre 3.000 y 3.900 pedidos diarios hasta el 12 de agosto;
`sap_VBAP` (líneas) no tiene ni una línea posterior al 20 de julio,
comprobado sin ningún filtro de planta ni de sociedad:

```sql
SELECT MAX(CAST(ERDAT AS DATE)) FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP`
-- 2026-07-20
```

Las dos tablas se escriben a diario (misma marca de modificación), así que el
proceso de carga corre; lo que no hace es traer filas nuevas a `sap_VBAP`.
Como "vendido" sale del join `VBAK × VBAP`, hereda el corte de la más
atrasada.

**Qué implica:** para el cálculo real de comisión es menos grave de lo que
parece (se paga sobre lo *cobrado*, y esa fase está al día), pero en el
dashboard hay que enseñar la fecha de corte de cada fase — si se pinta la
serie sin más, vendido cae a cero a partir del 21 de julio mientras las otras
suben, y parece un desplome de ventas en vez de una laguna de datos. Es un
problema de `D30_INTEGRATION` (la ingesta de SAP compartida del grupo), no de
este proyecto — hay que avisar a quien la mantenga.

**Cómo comprobar si ya está resuelto:**

```sql
SELECT MAX(CAST(ERDAT AS DATE)) AS max_vbap
FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP`;
```

Si devuelve una fecha reciente, basta con reejecutar
`data/consultas/DBC_silver_flujo_producto.sql` y la gold que sale de ella.

### El 65% del importe facturado no tiene CEDIS asignado

Detectado al probar el motor de flujo de producto contra la tabla gold real.
La cobertura de CEDIS del ~92,5% de `Resumen.md` está medida **en número de
líneas**. Medida en dinero se invierte:

| Fase | % líneas sin CEDIS | % **importe** sin CEDIS |
|---|---|---|
| vendido | 5,8 | **68,4** |
| facturado | 7,0 | **65,3** |
| cobrado | 24,7 | **83,2** |

Los porcentajes de líneas cuadran exactamente con los de `Resumen.md` — es la
misma realidad medida con otra vara, no una corrida distinta ni un error de
cálculo. La causa es el tamaño de las líneas: en facturado, una línea sin
CEDIS vale 25 veces más que una con CEDIS ($10.155 de media contra $409).

No es un dato ausente, es un mapeo incompleto: `almacen` y `oficina` vienen
informados en el 100% de esas líneas, pero esa combinación no existe en
`D20_DIMENSION.dm_cedis`, así que el `LEFT JOIN` de `v1_flujo_producto_dbc` no
encuentra pareja. Y se concentra en pocas combinaciones — solo 12 explican el
86,3% del importe sin CEDIS en facturado, y las 4 primeras el 66,9%:

| almacén | oficina | planta | % del hueco |
|---|---|---|---|
| BO28 | 0126 | DBCF | 21,7% |
| H793 | 0024 | DBC3 | 17,9% |
| DG01 | 0001 | DBC1 | 14,1% |
| H723 | 0001 | H7AG | 13,2% |

`DG01`/`0001`/`DBC1` ya estaba señalado como posible "Derivados de Ganado" sin
mapear — ahora se sabe cuánto pesa: 183 millones.

**Por qué importa:** cualquier gráfica desglosada por CEDIS enseña un tercio
del dinero si se oculta esta fila — no se puede esconder sin que el total no
cuadre y nadie sepa por qué. Y para el cálculo de comisión es tan bloqueante
como el export de GS03, porque la tarifa depende de CEDIS × oficina: dos
tercios del importe facturado no se pueden atribuir hoy.

**Qué pedirle al cliente:** una lista corta y cerrada — a qué CEDIS y qué
tipo de venta corresponde cada uno de esos 12 pares almacén+oficina. Con las
4 primeras se recupera el 67% del importe hoy sin asignar.

## Por qué existen dos consultas propias y no se toca la vista de Silvana

`Datos/sql/v1_flujo_producto_dbc.sql` (de Silvana, validada, fuente de
verdad) resuelve la parte difícil: el `UNION ALL` de las tres capas
(vendido, facturado, cobrado) directamente contra las tablas de SAP, con toda
la lógica de mapeo de dimensiones y conversión a caja. Esa lógica sigue
siendo suya y no se reescribe en ningún sitio — lo que cambia es dónde vive
el resultado antes de llegar al dashboard.

El problema, medido: es una vista, no una tabla, así que cada consulta rehace
el `UNION ALL` desde cero contra SAP — **8,98 GiB escaneados por consulta**.
El endpoint de flujo de producto necesita poder consultarse en cada render de
pantalla (filtros por CEDIS, división, tipo de venta, fecha); a ese coste,
cada filtro nuevo son otros 9 GiB.

La solución son dos pasos, no uno:

1. **`data/consultas/DBC_silver_flujo_producto.sql`** — materializa la vista
   de Silvana tal cual, sin tocar su lógica, en una tabla partida por
   `fecha` y agrupada por `fase, cedis, division_code`. Es el punto único de
   materialización: cuando comisiones necesite su propia agregación (por SET,
   cuando llegue GS03) o conciliación la suya, ambas pueden salir de aquí sin
   volver a pagar los 8,98 GiB.
2. **`data/consultas/DBC_gold_flujo_producto_diario.sql`** — sale de la
   tabla silver (no de la vista), agregada al grano que de verdad necesita la
   pantalla: fase × fecha × división × CEDIS × tipo de venta × unidad. Pesa
   4,7 MB y es la que lee `flujo_engine.py` en el backend.

Silvana ya tiene su propia vista agregada equivalente,
`v1_flujo_producto_dbc_resumen_diario` — el `GROUP BY` de la tabla gold la
duplica a propósito, porque la suya sigue leyendo la vista de 8,98 GiB y la
de aquí lee la tabla silver de unos cientos de MB. Si Silvana cambia su
agregación hay que replicar el cambio en la gold; lo que nunca se duplica es
el `UNION ALL` de las tres capas, que sigue siendo una sola fuente, la suya.

Separar detalle (silver, reutilizable) de agregado (gold, barato y
específico de una pantalla) evita que un consumidor futuro que necesite bajar
al detalle línea a línea (por ejemplo, para auditar por qué un CEDIS no
cuadra) tenga que volver a pagar los 8,98 GiB — y es el mismo patrón por
capas que ya usa el resto del grupo.

Coste: cada `CREATE OR REPLACE TABLE` sale por ~0,06 USD; un refresco diario
de las dos, menos de 2 USD/mes. Las dos consultas, en ese orden, son el DAG
diario completo el día que esto se orqueste en Airflow — hoy se ejecutan a
mano. Mientras dura la fase de pruebas viven en `ZZ_PRUEBAS`, el mismo
dataset donde Silvana dejó sus vistas.

## Vías descartadas (para no reinvestigarlas)

Con acceso completo a BigQuery se revisaron varias alternativas que antes no
se podían comprobar del todo por permisos. Ninguna aportó un atajo:

- **`D40_EDW`**: `edw_billing_header_payment` y `edw_billing_items_payment`
  están completamente vacías (0 filas). `edw_status_billing_payment` tiene
  `status_payment` y `clearing_dt` en NULL el 100% del tiempo, en las 22
  compañías del dataset, no solo DBC — no sirve para "cobrado".
  `edw_header_billing_model_cedis` es una alternativa a nivel documento (no
  línea) para "facturado", con el monto en el mismo orden de magnitud (+3.3%
  a +6.3%) que la vista actual, pero no aporta nada nuevo.
- **`D60_REPORTING` / `D62_STREAMLIT`**: son de Maka/Hidrocarburos y de un
  programa de lealtad (`MSJ_*`) — sin relación con DBC/comisiones.
  `PRECIOS_AMPLIADO` (dentro de `D60_REPORTING`) es detección de anomalías de
  precio en vivo con una ventana móvil de ~30 días — no explica el gap
  vendido→facturado de la sección 4.3 del borrador técnico (11,05%, atribuido
  a descuentos/rebates aplicados solo al facturar), porque compara contra una
  mediana móvil, no contra el precio de venta original, y no llega a enero
  2026, que es donde está medido el gap.
- **`SETLEAF`/`SETHEADER`/`SETNODE`/`GS01`/`GS02`/`GS03`/`ZSDFI`**: búsqueda
  contra `INFORMATION_SCHEMA.TABLES` de todo el proyecto — cero resultados.
  Confirmado que no están replicadas en BigQuery, no es tema de permisos.
  GS03 sigue siendo estrictamente necesario del cliente para el SET de
  producto.
- **`PRODH`** (jerarquía de producto SAP): existe, pero solo en los
  snapshots diarios `D00_SANDBOX.proan_2LIS_13_VDITM_*`, no en la tabla
  principal. Y no separa las marcas limpiamente: en división Huevo, el
  código `0000400001` mezcla materiales "SAN JUAN" y "PORTALES" — parece
  agrupar por formato de empaque, no por marca comercial. Descartado como
  sustituto de GS03.
- **`sap_mseg` vs. `MB51`** (para validar traspasos): probado contra el único
  ejemplo real disponible (Sociedad `PAN`, Centro `PANF`, Almacén `H701`,
  semana 19-25 jul 2025, total $344.102,52). Ninguna combinación de tipo de
  movimiento (`BWART`) disponible reproduce el total, ni en cantidad ni en
  importe — se probó el candidato lógico `301/S` (traspaso recibido) sin
  éxito. Inconcluso, no una prueba en contra: falta que el cliente confirme
  qué código(s) `BWART` usa su MB51 para "traspasos", y el ejemplo es de
  compañía `PAN`, no `DBC`, lo que añade otra reserva.

## Pendientes de negocio que resultaron ser casi nada

- **36 combinaciones almacén+oficina con sector ambiguo en `dm_cedis`**
  (Huevo/Croqueta vs. Tortilla): revisadas una por una, en 35 de 36 el
  resultado final (`cedis`, `tipo_venta`) es idéntico sin importar qué sector
  gane el desempate — la ambigüedad no se propaga, es cosmética. Queda un
  solo caso real: almacén `H717`/oficina `0122` (Celaya), donde sí cambia
  entre "Celaya Agustin" (tipo_venta `EXTRAS`) y "Celaya Genaro" (tipo_venta
  `VTA EN RUTA`) — coincide con dos comisionistas de Celaya que el borrador
  no tenía documentados. La regla provisional de desempate (primer sector
  alfabético) sigue en pie porque produce el resultado correcto en 35/36
  casos; no se tocó `dim_cedis_v1`.
- **Facturas repartidas entre 2 almacenes**: real, pero solo 18 de 193.516
  facturas DBC de 2026 (0,11% del monto, $2,17M de $1.965M) — bajo impacto
  mientras no haya regla de negocio.

## Conciliación: estructura viable, falta maestro de proveedores

`sap_bsik_open_items` (`D30_INTEGRATION`) tiene exactamente los campos que se
esperarían de `FBL1N`: número de proveedor, compañía, cuenta contable,
importe, fecha/documento de compensación, término de pago. Estructuralmente
es viable para el módulo de conciliación.

El problema: no existe en BigQuery ningún maestro de proveedores con nombre
(tipo `LFA1`) — no se puede mapear número de proveedor → nombre de
comisionista por cuenta propia. El universo de proveedores por división es
manejable (7 en Abarrote, 155 en Huevo, 112 en Botana, 70 en Alimento — no
miles), pero mezcla proveedores normales (insumos, empaque) con
comisionistas, y al menos un `LIFNR` no sigue el formato numérico estándar
(`BBV-670730`) — el "rango de número de proveedor" que se le pidió al cliente
quizá no sea un rango numérico limpio. Sigue dependiendo de esa respuesta;
esto no se resuelve con más SQL.
