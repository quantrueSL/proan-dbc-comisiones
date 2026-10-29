# Por qué un pago no cuadra y se corrige después — análisis (28 oct 2026)

Origen: reunión con el cliente. Quien concilia paga lo que sale del reporte de SAP al momento, y después paga diferencias
(columna ANTERIOR del Excel de seguimiento `reportes_proan/folloup_maribel/COMISION VUALA.xlsx`). Caso guía: José Guadalupe Campos
Becerra (LIFNR 18853), Botana (BO), julio: pagado 47,477.90 contra 50,618.83 calculado (dif. 3,140.93).

## Hallazgos
1. **Faltantes por producto (Botana, hasta agosto).** En el Excel de seguimiento, para José la diferencia entre lo calculado hoy y lo pagado
   en la semana es EXACTAMENTE la comisión de 4 productos: 17126 SW ROLL PIÑA C/14 TIRA, 17401 SW CAKE 10 PACK, 17402 SW ROLL 10 PACK y
   17630 SW CAKE C/9 DISP (jul: 264.00, 421.50, 295.50, 491.25, 426.00). Con esos 4 fuera, cuadran 48-83 de ~100 comisionistas-semana de
   cada mes de marzo a agosto (sin ellos: 0-10). **Desde septiembre ya se pagan** (107 de 140 cuadran sin excluir nada).
   Croqueta (IA) tiene un patrón parecido con MIXI PRIME 10 KG, CHOP ADULTO RAZAS PEQUEÑAS 15 y MIXI 9 KG hasta agosto (menos claro: el azar
   explica parte). Huevo y Leche no tienen un conjunto de productos.
2. **Pagos de arrastre.** Un pago MAYOR a lo calculado suele ser el cobro de faltantes de semanas anteriores: lo pagado de más es la suma
   exacta (±$1) de los faltantes de 1-4 pagos previos de la misma fila. Acierta en Leche 93/137 (68%), Huevo 127/436 (29%), Croqueta 59/142,
   Botana solo 14/165 (los arrastres de Botana no son sumas limpias). Sin relación (objetivo desplazado) acierta ~1-3%, así que no es azar.
3. **En Botana, los arrastres (AG) no son sumas contiguas de esos 4 productos** (3%, igual al azar). José: 1,242.68 pagado el 15-21 ago es un
   faltante puntual de la semana 25-31 jul que no son esos productos; 1,555.52 del 1-9 oct = esos 4 productos del 25 jul al 21 ago (+0.73).
4. **Octubre (Botana) cambia de signo:** lo pagado es MAYOR que lo calculado (José -500.80, -733.80, -564.00). Hay líneas "material sin SET"
   (p. ej. 20054 VUALA BIG ABUELITA C/8 TIRA-48P S/P, 480 base en 1-9 oct) sin tarifa en nuestra tabla: ella las paga, nosotros no.
5. **Detalle de Pasivo Temporal (líneas de la factura): NO lo tenemos.** BSAK trae solo la línea del proveedor (31) del documento RE
   (p. ej. 5100012070: 7,606.82, XBLNR 753). Las líneas de cuenta 2090000 (con Asignación = pedido) son partidas de mayor: viven en
   BSEG/BSAS/BSIS y no están cargadas (RT_BSIS solo trae partidas abiertas recientes de otras sociedades; no hay BSAS ni BSEG).
   En el Excel de seguimiento cada semana tiene su pedido (columna PEDIDO) y la factura (XBLNR), así que con esas líneas se podría ver a qué
   semana corresponde cada línea de arrastre.

## Posibles arreglos (para decidir)
- Sugerencia por producto: en un pago con faltante, buscar productos cuya comisión en la ventana sume el faltante (≤3), y marcarlos en el
  detalle. Reconoce el caso de Botana y avisa si es siempre el mismo producto.
- Saldo por fila: mostrar el acumulado (calculado - pagado) y sugerir "este pago de más cubre estos faltantes anteriores" (sumas exactas).
- Pedir a SAP BSEG/BSAS de DBC y PAN (cuentas de pasivo temporal) para ver las líneas de arrastre con su pedido.
- Material sin SET: revisar la tarifa de los productos nuevos antes de conciliar octubre.

## Anexo: Botana sin tarifa (cobrado desde enero, DBC; "cobrado" = monto cobrado, no comisión)
La tarifa sale de: SET del material (SAP `sap_setleaf_comisiones`) + almacén-oficina (CEDIS) + menudeo/mayoreo (archivo de tarifas BO del cliente).
Tres puntos de falla:
- **Material sin SET** (12,738 líneas, $1.19M): 20054 BIG ABUELITA C/8 TIRA (desde 1-oct, $427k), 20094 SW CAKE 10 PACK C/12 DISP-120P HW (desde 18-sep, $413k),
  20191 SW CAKE CREM C/14 TIRA-84P S/P HW (desde 21-sep, $353k). Ninguno aparece en el archivo de tarifas BO, en almacén-oficinas BO, en el Set de Datos de
  Materiales ni en el Excel de seguimiento (que no trae códigos de material). SAP: SWICH = 13101, 17401, 17492, 17494, 17630, 20261, 20263; SW_ROLL = 17124, 17126, 17402;
  BIG_CHO = 14990. En el Excel de seguimiento ABUELITA sí se paga: dentro de BIG CHOCOLATE (José, 1-9 oct: 446 × 1.10 + 34 × 0.30 = 500.80, exacto).
  20094/20191: en septiembre NO se pagaron (lo pagado coincide con el calculado sin ellos); octubre no concluyente.
- **Sin CEDIS** (7,689 líneas, $1.56M): almacén BO47 oficina 0240 ($886k, desde 14-abr), BO47 oficina 0242 ($650k, desde 27-may), BO48 oficina 0280 ($28k, desde 18-sep).
  No existen en dm_cedis, en el archivo almacén-oficinas BO, ni tienen comisionista en dm_DBC_comisionista; el Excel de seguimiento no tiene fila BO47 ni BO48.
- **Sin tarifa para esa llave** (405 líneas, $0.90M): oficina 0227 Celaya Genaro MED MAYOREO ($813k desde ene; el archivo solo lista Celaya 0082, 0083, 0012, 0145, 0122),
  0112 Tuxtla 2 VTA EN PISO ($37k), 0106 San Luis VTA EN PISO ($17k), 0169 San Luis MED MAYOREO ($15k, en el archivo está bajo BO39), 0028 Leon 1 ($10k, bajo BO35).
Otros: Huevo PAN con 9 materiales sin SET ($2.47M cobrado; 15292 HUEVO PORTALES 30B, 16479 y 16469 BCO KRAFT, 13243 SAN JUAN...), Leche 20678 desde 19-oct ($95k).

## Plantilla para el cliente
`data/correos/plantilla_tarifas_faltantes_2026-10-28_v5.xlsx` (una hoja por división: Botana, Huevo, Croqueta, Leche, Abarrotes). Secciones A (materiales sin SET)
y B (oficinas con ventas sin tarifa, formato de su archivo de tarifas: una oficina por fila, SET × menudeo/mayoreo). Regla de color: el dato que ya tenemos
se muestra; amarillo vacío = hay que completarlo; gris vacío = no hace falta. Excluye oficinas de México y la 0130 (no comisionan, cliente 14-oct); la 0153 lleva nota.
Resumen por división (renglones): Botana 3 materiales + 12 oficinas; Huevo 10 + 3; Croqueta 8 + 10; Leche 1 + 17; Abarrotes 2 materiales.
Lo generó `scratchpad/plantilla_v5.py` (no está en el repositorio); datos de las consultas a D50/D60 del 28-oct.

## Decisiones (28 oct)
- La sugerencia por producto (buscar los productos de la ventana cuya comisión suma el faltante) se aprobó como idea, pero NO se implementa todavía.
- Pendientes con el cliente: SET y tarifa de 20054, 20094 y 20191; si se pagan comisiones en BO47/BO48 (oficinas 0240, 0242, 0280); tarifa de 0227 mayoreo;
  qué hacer con 0112, 0106, 0169 y 0028 (están bajo otro almacén en su archivo); cuánto falta de pagar de los 4 productos de Botana de enero a agosto.
