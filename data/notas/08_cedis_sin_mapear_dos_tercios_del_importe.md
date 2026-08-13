# El 65% del importe facturado no tiene CEDIS asignado

_13 de agosto de 2026. Detectado al probar el motor de flujo de producto contra
la tabla gold real._

## El hallazgo

La cobertura de CEDIS del ~92,5% que aparece en `Resumen.md` está medida **en
número de líneas**. Medida en dinero se invierte:

| Fase | % líneas sin CEDIS | % **importe** sin CEDIS |
|---|---|---|
| vendido | 5,8 | **68,4** |
| facturado | 7,0 | **65,3** |
| cobrado | 24,7 | **83,2** |

Los porcentajes de líneas cuadran exactamente con los de `Resumen.md`, así que
no es una corrida distinta ni un error de cálculo: es la misma realidad medida
con otra vara.

La causa de la diferencia es el tamaño de las líneas. En facturado:

| | líneas | importe | media por línea |
|---|---|---|---|
| Con CEDIS | 1.688.599 | $690.238.875 | $409 |
| **Sin CEDIS** | 127.720 | **$1.297.057.383** | **$10.155** |

Una línea sin CEDIS vale 25 veces más que una con CEDIS. Son pocas y gordas.

## No es un dato ausente, es un mapeo incompleto

`almacen` y `oficina` vienen informados en el 100% de esas líneas (`COUNTIF(almacen
IS NULL)` = 0, ídem oficina). Lo que ocurre es que esa combinación **no existe en
`D20_DIMENSION.dm_cedis`**, así que el `LEFT JOIN` de `v1_flujo_producto_dbc` no
encuentra pareja.

## Y se concentra en muy pocas combinaciones

Solo 12 combinaciones almacén+oficina explican el **86,3%** del importe sin CEDIS
en facturado. Las cuatro primeras, el 66,9%:

| almacén | oficina | planta | líneas | importe | % del hueco |
|---|---|---|---|---|---|
| BO28 | 0126 | DBCF | 3.805 | $281.586.193 | 21,7% |
| H793 | 0024 | DBC3 | 2.768 | $232.660.165 | 17,9% |
| DG01 | 0001 | DBC1 | 45.623 | $183.244.722 | 14,1% |
| H723 | 0001 | H7AG | 882 | $170.982.269 | 13,2% |
| H736 | 0023 | DBCF | 15.514 | $59.090.938 | 4,6% |
| BO28 | 0189 | DBCF | 1.426 | $57.932.895 | 4,5% |
| H780 | 0133 | DBCF | 8.755 | $27.922.299 | 2,2% |
| H773 | 0136 | DBCF | 6.880 | $26.693.833 | 2,1% |
| H745 | 0064 | DBCF | 7.672 | $23.746.421 | 1,8% |
| BO01 | 0189 | DBCF | 801 | $23.364.523 | 1,8% |
| A212 | 0054 | DBCF | 4.287 | $16.651.143 | 1,3% |
| BO01 | 0126 | DBCF | 273 | $13.726.780 | 1,1% |

`DG01` / `0001` / `DBC1` ya estaba en la lista de preguntas al cliente
(pendiente #7 de `Resumen.md`, "posible Derivados de Ganado sin mapear"). Ahora
sabemos cuánto pesa: 183 millones, el 14,1% del hueco.

## Por qué importa

- **Para el dashboard**: cualquier gráfica desglosada por CEDIS enseña un tercio
  del dinero. No se puede ocultar la fila sin asignar — hay que mostrarla
  explícitamente, o el total por CEDIS no cuadrará nunca con el total general y
  nadie sabrá por qué.
- **Para el cálculo de comisión**: la tarifa depende de CEDIS × oficina. Dos
  tercios del importe facturado no se pueden atribuir hoy. Esto es tan
  bloqueante como el export de GS03, y no estaba identificado como tal.

## Qué pedirle al cliente

Convertir estas 12 combinaciones en una pregunta concreta: **a qué CEDIS y qué
tipo de venta corresponde cada almacén+oficina de la tabla de arriba**. Es una
lista corta y cerrada, no una petición abierta. Con las cuatro primeras se
recupera el 67% del importe hoy sin asignar.

## Cómo reproducirlo

```sql
SELECT almacen, oficina, planta,
       COUNT(*) AS lineas,
       ROUND(SUM(monto), 0) AS monto,
       ROUND(100 * SUM(monto) / SUM(SUM(monto)) OVER (), 1) AS pct_del_hueco
FROM `proan-quantrue.ZZ_PRUEBAS.DBC_silver_flujo_producto`
WHERE cedis IS NULL AND fase = 'facturado'
GROUP BY almacen, oficina, planta
ORDER BY monto DESC
LIMIT 12;
```
