# Medición previa a la pestaña de conciliación por cortes — 14 de octubre de 2026

Solo `SELECT` sobre BigQuery (wrapper de solo lectura). Pagos de `proan_BSAK_20260929`
(misma lógica de parseo que `DBC_gold_conciliacion_pago_semanal.sql`); calculado
de `D60_REPORTING.DBC_gold_conciliacion_producto_diario`. Rango de las pruebas de
cálculo: pagos con ventana entre 2026-01-10 y 2026-09-05, con pagado > 0.

## 1. Identificador del pago

Unidad natural: el documento de factura de comisión (`BLART = 'RE'`) de BSAK,
llave `BUKRS | GJAHR | BELNR`. No depende del texto.

| Medición | Resultado |
|---|---|
| Documentos RE de comisión con pago KZ en su compensación | 5,060 ($142.9M) |
| Líneas por documento | 1 en los 5,060 |
| Textos distintos por documento | 1 en los 5,060 |
| Compensaciones (`AUGBL`) por documento | 1 en los 5,060 |
| Documentos por compensación | 1: 4,666 · 2: 194 · 3: 2 |
| Documentos con la misma fila (sociedad+LIFNR+división) y misma ventana | 39 unidades con 2 documentos ($1.1M) |

Conclusión: la compensación (`AUGBL`) NO sirve de llave, porque una transferencia
agrupa 2-3 facturas de periodos o divisiones distintos. El documento RE sí es 1:1
con un periodo. Si dos documentos comparten fila y ventana (39 casos), el pago de
pantalla es la suma y su identificador es el documento de menor número, con los
demás listados.

## 2. Qué tan confiable es la ventana que sale del texto

- 5,001 de 5,060 documentos traen ventana parseable. **59 documentos (~$1.6M) no**
  (texto sin fecha o sin división): entran como pagos sin ventana.
- Solo **2,955 de 4,963 ventanas (60%) son sábado-viernes de 7 días**. Las demás:
  959 de 6 días o menos, 1,031 de 8 a 13 días, 1 de 14 y 17 de más de 14.
- Contra el pago anterior de la misma fila (4,823 pagos con anterior):
  **4,451 contiguos (92.3%)**, 316 con hueco (6.6%: 107 de 1-3 días, 137 de 4-7 días,
  72 de más de 7), **56 con traslape** (1.2%: 42 de 1-7 días, 14 de más de 7).
- Hay 140 pagos que son el primero de su fila en el rango.

## 3. Cuánto se explica moviendo bordes (hasta 3 días, cada pago por separado)

4,280 pagos medidos ($120M). Tolerancia ±$1.

| Clase | Pagos | Pagado |
|---|---|---|
| Cuadra sin tocar nada | 1,072 (25%) | $19.6M |
| Se explica moviendo un borde ≤3 días | 444 (10%) | $4.1M |
| Casi cuadra (±2%) sin explicación de borde | 360 (8%) | $17.4M |
| Pago sin cálculo (calculado = 0) | 394 (9%) | $3.7M |
| Sin explicación | 2,010 (47%) | $75.3M |

Los 444 de borde: todos con **una sola** opción exacta; 342 (77%) mueven un solo día,
349 solo el fin de la ventana, 74 solo el inicio, 21 ambos. No se midió el efecto
sobre el pago vecino (cada pago se evaluó aislado).

De los 3,208 que no cuadran sin tocar nada y no son de borde:
- Sumar las demás divisiones del mismo comisionista en la misma ventana: **0** casos
  cuadran ±$1.
- Extender la ventana hasta el pago anterior (hueco): 15 casos, $9K.
- Sin explicación, por sociedad-división: PAN-H 553 pagos ($59.0M), DBC-BO 778
  ($19.3M), DBC-H 502 ($12.3M), DBC-IA 397 ($2.0M), DBC-L 168 ($0.4M).
- Calculado frente a pagado en esos sin explicación: 758 con calculado más de 5%
  sobre el pago, 740 dentro de ±5%, 374 entre 5-20% bajo, 526 más de 20% bajo.

Lectura: los cortes arreglan una parte pequeña y limpia (~10% de los pagos, casi todos
de un solo día). La mayor parte de lo que no cuadra no es un problema de ventana; es
una diferencia de monto. La pestaña debe tratar bien los dos casos sin prometer que
las sugerencias de borde resuelven el grueso.

## 4. Dos rutas de atribución del calculado (documentado)

El pago se asigna a un comisionista por oficina (`oficina_lifnr` en
`pago_semanal.sql`, vía `dm_DBC_comisionista`) y la tabla diaria ya trae
`comisionista_id`. Se comparó el calculado de `DBC_gold_conciliacion_pago_semanal`
(`comision_calculada`, por oficina) con la suma diaria por `comisionista_id` en la
misma ventana: **4,079 de 4,079 pagos iguales (±$1)**, diferencia neta $0.

Además, 202 pagos ($2.6M) no están en `pago_semanal` (la oficina no resuelve o es
ambigua, p. ej. OROL) y tampoco tienen calculado diario: coinciden en ser "pago sin
cálculo". Por eso la pestaña nueva puede usar solo la tabla diaria como fuente del
calculado sin diferir de la pestaña vieja. Si en el futuro cambia la dimensión de
comisionistas, repetir esta comparación.

## 5. Efectos en el diseño

- Llave en Firestore: documento RE (`BUKRS|GJAHR|BELNR`), no el texto. El texto solo
  propone la ventana por defecto.
- Los 59 documentos sin ventana y los 39 con dos documentos necesitan manejo propio.
- Hay que tolerar traslapes y huecos (1.2% y 6.6%): se muestran como advertencia en
  vez de bloquearlos.

## 6. Del 47% sin explicación: Huevo con Abarrotes, PAN-H y DBC-BO

Mismo rango y fuentes que arriba. Tolerancias: exacto ±$1, aproximado ±2% o ±5%.

### 6.1 DBC-Huevo + DBC-Abarrotes (807 pagos, $16.19M pagado)

La suma de Abarrotes se hace por comisionista y misma ventana de fechas de cobro.

| Calculado | Exacto ±$1 | ±1% | ±2% | ±5% | Más de 5% |
|---|---|---|---|---|---|
| Solo Huevo | 192 | 18 | 13 | 64 | 520 ($11.6M) |
| Huevo + Abarrotes | 339 | 33 | 9 | 69 | 357 ($7.3M) |

- Calculado total frente a pagado: solo Huevo $12.2M (-24.6%); con Abarrotes $15.5M (-4.0%).
- 364 de 807 pagos (45%) tienen Abarrotes cobrado en su ventana ($3.34M).
- De los 597 pagos que no cuadraban solo con Huevo (más de 1%), 146 pasan a exactos y 17 a ±1%.
- Residuo (357 pagos, $7.3M): 204 con calculado menor que lo pagado, 153 con calculado mayor, 68 con
  calculado cero ($0.69M). Sumar además Botana, Alimento o Leche explica solo 9 pagos. Se reparte en
  todos los meses y se concentra en pocos comisionistas (0000004335 con 25 pagos; 0000014917 y
  0000016385 con 33 pagos cada uno y calculado cero).
- No se midió mover bordes sobre Huevo + Abarrotes.

### 6.2 PAN-H (980 pagos, $78.2M) y DBC-BO (935 pagos, $20.7M)

| | PAN-H | DBC-BO |
|---|---|---|
| Exactos ±$1 | 262 (27%) | 61 (7%) |
| Dentro de ±2% | 376 (38%) | 172 (18%) |
| Razón calculado/pagado p10 · p25 · p50 · p75 · p90 | 0.80 · 0.97 · 1.00 · 1.08 · 1.29 | 0.84 · 1.00 · 1.04 · 1.11 · 1.29 |
| Pagos con calculado más de 2% sobre lo pagado | 260 (exceso $5.9M) | 522 (exceso $1.7M) |

Causas descartadas con medición:

- **Desfase de ventana:** correr la ventana completa de -14 a +14 días solo agrega 2 pagos exactos en
  PAN-H y 5 en BO. El corrimiento a la fecha de factura es peor (30 exactos contra 262 en PAN-H; 42
  contra 61 en BO).
- **Compensación entre periodos:** sumar rachas de 2, 4 u 8 pagos consecutivos no mejora el cuadre
  (PAN-H 27%, 34% y 35%; BO 23% a 8 pagos). Incluso en los comisionistas cuyo total anda en ±10% pero que casi
  nunca cuadran por pago, las rachas de 8 cuadran 19% (PAN-H) y 26% (BO).
- **Una sola factura o una dimensión:** el exceso de un pago coincide ±$1 con una sola factura en 10 de
  260 pagos de PAN-H y 12 de 522 de BO (control con importes falsos: 0 y 2). Ninguna oficina, CEDIS ni
  tipo de venta lo explica. BO usa siempre unidad de tarifa paquete y PAN-H siempre kg.
- **Razón constante por comisionista (tarifa distinta):** en casi todas las filas la razón por pago
  no es estable (solo 1 fila de PAN-H y 1 de BO con más de 70% de pagos en ±2% de su mediana).

Lo que sí se ve:

- **Concentración por comisionista:** los 12 comisionistas con más diferencia suman 69% de la
  diferencia absoluta en PAN-H y 68% en BO. Varios son los mismos en las dos (0000004335 Noel García,
  0000015199 Brandon Hernández, 0000001450 Edgardo Trujillo, 0000001019 Florentino González,
  0000009401 Raúl Saldaña).
- **Dos LIFNR sin nombre y sin calculado** (0000014917 y 0000016385) están entre los 4 primeros de
  ambas: $1.8M (14%) de la diferencia absoluta de PAN-H y $0.36M (11%) de la de BO. Es el hueco de
  dimensión ya conocido.
- **BO está sesgado hacia calculado mayor:** mediana de razón 1.036, 60% de los pagos con calculado por
  arriba.
- **PAN-H está repartido en las dos direcciones**, con razón total ±2% en 12 de 29 filas ($38.9M),
  entre 1.02 y 1.10 en 13 filas ($29.6M) y calculado cero en 3.

Lectura: no es desfase, ventana, documento suelto ni producto. Se parece más a comportamiento propio de
cada comisionista (acuerdos o ajustes manuales). No se puede cerrar solo con datos de BigQuery.

## 7. Regla de cierre: el último día del mes va con el pago de la semana siguiente

Dicha por Silvana el 14-oct (el cierre se hace durante ese día y no alcanza a entrar en la misma
semana). Se midió sobre los pagos de ene-sep cuyas ventanas terminan en fin de mes (1,131 de las 5,001
ventanas; ninguna cruza el fin de mes por dentro, todas están cortadas ahí).

- Con cobros el último día: 740 pagos. Con ese día dentro del pago cuadran 7 (1%); sin él, 225 (31%).
  La regla se sostiene para el pago que termina en fin de mes.
- A qué pago va ese día NO se sostiene con los datos. Sumarlo al pago siguiente (1.º, 2.º, 3.º o 4.º)
  mejora 55, 24, 40 y 0 pagos y empeora 224, 266, 262 y 89. Dárselo al pago que arranca el día 1 rompe 211
  pagos que ya cuadraban. Puede ser distinto por comisionista, o que ese día se pague fuera de estas ventanas.
- Decisión: el pago que termina en fin de mes pasa a terminar un día antes (parte de la ventana por
  defecto) y ese día queda como un hueco de un día marcado `cierre`, sin asignar. La pantalla lo enseña
  aparte ("Cierre de mes") y no lo cuenta como cobros sin pago.
- Efecto sobre el motor, mismas filas: cuadran 1,072 -> 1,290 (de 4,280); con sugerencia de borde 443 -> 211;
  sin explicación 2,765 -> 2,779. La regla explica 232 de las 443 sugerencias de borde de la sección 3.
- Pendiente: asignar días sueltos a un pago que no sea contiguo (para mandar el día de cierre al pago
  correcto cuando se sepa cuál es). Hoy una ventana es un rango continuo.
