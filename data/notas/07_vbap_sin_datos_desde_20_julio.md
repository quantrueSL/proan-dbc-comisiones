# `sap_VBAP` sin datos nuevos desde el 20 de julio de 2026

_13 de agosto de 2026. Detectado al validar las tablas silver/gold contra las
cifras de `Resumen.md`._

## El síntoma

La fase **vendido** del flujo de producto se corta el **2026-07-20**, mientras
facturado llega al 2026-08-13 y cobrado al 2026-08-12.

Al comparar contra la corrida apuntada en `Resumen.md` (12 de agosto), vendido
reproducía las cifras **al céntimo** (1.506.006 filas, $1.867.026.840,65) mientras
las otras dos fases crecían. Un cuadre perfecto entre dos corridas separadas por
un día es sospechoso, no tranquilizador: significaba que no había entrado dato
nuevo.

## La causa

No es la SQL ni el filtro de DBC. Es la tabla origen:

| Tabla | Última fecha con datos | Última modificación |
|---|---|---|
| `D30_INTEGRATION.sap_VBAK` (cabeceras) | 2026-08-12 | 2026-08-13 14:02 UTC |
| `D30_INTEGRATION.sap_VBAP` (líneas) | **2026-07-20** | 2026-08-13 14:02 UTC |

`sap_VBAK` tiene entre 3.000 y 3.900 pedidos diarios hasta el 12 de agosto.
`sap_VBAP` no tiene **ni una línea** posterior al 20 de julio — comprobado sin
ningún filtro, ni de planta ni de sociedad:

```sql
SELECT MAX(CAST(ERDAT AS DATE)) FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP`
-- 2026-07-20
```

Las dos tablas se escriben a diario (misma marca de modificación), así que el
proceso de carga corre; lo que no hace es traer filas nuevas a `sap_VBAP`.
Como "vendido" sale del join `VBAK × VBAP`, hereda el corte de la más atrasada.

## Qué implica

- **No se puede calcular comisión sobre lo vendido después del 20 de julio.**
  Para el cálculo real esto es menos grave de lo que parece: la comisión se paga
  sobre lo *cobrado*, y esa fase está al día.
- **En el dashboard hay que enseñar la fecha de corte de cada fase.** Si se pinta
  la serie sin más, vendido cae a cero a partir del 21 de julio mientras las
  otras suben, y parece un desplome de ventas en vez de una laguna de datos.
- **Es de fuera de este proyecto.** `D30_INTEGRATION` es la ingesta de SAP
  compartida del grupo. Hay que avisar a quien la mantenga; desde aquí no se
  arregla.

## Cómo comprobar si ya está resuelto

```sql
SELECT MAX(CAST(ERDAT AS DATE)) AS max_vbap
FROM `proan-quantrue.D30_INTEGRATION.sap_VBAP`;
```

Si devuelve una fecha reciente, basta con reejecutar
`data/consultas/DBC_silver_flujo_producto.sql` y la gold que sale de ella.
