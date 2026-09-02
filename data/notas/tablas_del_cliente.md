# Las tablas de comisión del cliente — lectura a fondo

_24 de agosto de 2026. Trece Excel recibidos del cliente el 24/08 en respuesta
al correo del senior (las cinco preguntas: fuente de la comisión, diccionario
almacén-oficina completo, si la comisión depende del comisionista, qué
divisiones cuentan, y el código BWART de los traspasos). Los ficheros están en
`reportes_proan/`._

## Actualización del 25 de agosto: el cliente contestó, y el hueco no era un hueco

Respondieron a las seis preguntas. Lo esencial:

**Los almacenes que faltaban no faltan: no pertenecen a ningún CEDIS.** `BO28`,
`BO01`, `H723` y `H793` son **almacenes centrales**; textualmente, «no pasan por
ningún cedis, por ende no generan comisión para nadie». Y eso incluye a `H793`,
que en SAP se llama «CEDIS SAN JUAN» — un rótulo no es una fuente, y nuestra
deducción de que era el CEDIS San Juan estaba mal.

**Con eso y el filtro de divisiones, el «Sin asignar» pasa del 65% al 1,2%.** No
por haber encontrado un mapeo mejor: porque dos tercios de aquel hueco nunca
fueron un hueco. Eran divisiones que el cliente no opera (82-100% sin CEDIS
porque nadie mantiene ese mapeo) y cuatro almacenes centrales cuya respuesta
correcta a «¿de qué CEDIS es?» es «de ninguno».

| escenario, sobre facturado | importe | sin CEDIS |
|---|---|---|
| como estaba | $2.065,5 M | 60,7% |
| sin almacenes centrales | $1.233,1 M | 34,2% |
| sin centrales y solo divisiones en operación | $732,5 M | 1,2% |
| **y con el escalón 3 arreglado** (ver abajo) | **$732,5 M** | **0,18%** |

### El escalón 3 llevaba dos días sin ejecutarse

Al medir de dónde salía cada peso para el artifact de linaje apareció que
`cedis_origen = 'lista de nombres'` tenía **0 filas** en los 3,7 millones de
silver. El tercer escalón de la cadena de CEDIS —el que cruza por nombre de
almacén contra la lista del cliente— nunca llegaba a ejecutarse:

```sql
AND (dma.planta = '' OR dma.planta = p.WERKS)
```

El fichero del cliente no trae columna de planta, así que `dma.planta` llegaba
`NULL` en las 59 filas. Y `NULL = ''` en SQL no es `FALSE`, es `NULL`: la
condición no se cumplía jamás. Un fallo que no da error, no rompe ningún test y
no deja rastro — solo un escalón entero que no hace nada.

Arreglado el 25/08 normalizando en la vista (`IFNULL(l.planta, '')`, que es
donde vive el contrato «planta vacía = vale para cualquier planta») y, por si
acaso, haciendo la condición del `ON` a prueba de nulos en las tres ramas.

**Lo que valía:** cuatro almacenes existen solo en la lista del cliente
(`BO29`, `BO30`, `BO43`, `H770`), y uno de ellos factura: **`BO43` → «MEXICO
CARLOS»**, división Botana, **$7,7 M**. Con eso el hueco baja de **$9,0 M
(1,24%) a $1,3 M (0,18%)**, en 5.485 líneas.

De dónde sale cada peso del facturado en alcance, ya arreglado:

| escalón | cómo cruza | importe | % |
|---|---|---|---|
| 1 · `dim_cedis_v1` | almacén + oficina | $708,0 M | 96,65% |
| 2 · `dim_cedis_almacen_v1` | almacén solo | $15,5 M | 2,12% |
| 3 · `dim_cedis_nombre_v1` | nombre de almacén | $7,7 M | 1,06% |
| 4 · `dim_cedis_oficina_v1` | oficina sola | $0,0 M | 0,00% |
| — | sin resolver | $1,3 M | 0,18% |

El escalón 4 ya no aporta nada dentro del alcance: los $80,4 M que recuperaba
eran todos de divisiones que DBC no opera.

Las otras cuatro respuestas:

- **Leche**: contestaron «83 light, 83 entera y 84 deslactosada», con el 83
  repetido. Lo resuelve SAP sin volver a preguntar: el texto de la línea de
  pedido en `sap_VBAP` dice `18883` LECHE LIGHT, `18884` LECHE ENTERA y `18885`
  LECHE DESLACTOSADA. Solo acertaron el primero.
- **HINDUSTRIA**: se paga por caja de plástico retornable devuelta, y «para los
  demás materiales es por kg». Verificado: el peso viene en KG en el 100% de las
  líneas y la caja de huevo pesa 20,41 kg, así que 1,45/kg son ~$29,6 por caja —
  del mismo orden que los 42 por caja de plástico. Calculado de las dos formas,
  la comisión de huevo sale al **3,91% del facturado por kg** y al **0,23% por
  caja**; lo segundo no existe en distribución. **La base de huevo es el peso.**
  Aun así no afecta hoy: el único material de HINDUSTRIA (`12262`) dejó de
  facturar en 2025.
- **`H159`**: «Mexico Carlos de Anda tiene sus oficinas propias, así como algunos
  clientes que ya van facturados desde aquí desde la 001». O sea que la oficina
  0001 es legítima ahí. `dm_cedis` ya lo mapea; no había nada que arreglar.
- **Botana**: pendiente de Alejandro Vázquez.

## Actualización del 1 de septiembre de 2026 (Silvana)

Cuatro cosas de esta nota quedaron superadas al construir la consulta de
comisiones completa (`Datos/sql/v1_comision_dbc_completo.sql`, ver
`Datos/Comisiones_DBC_Borrador_Tecnico.md` sección 16):

- **El SET ya no depende de recargar el Excel de GS03.** `D00_SANDBOX.sap_setleaf_comisiones`
  existe en BigQuery: 748 filas, 30 SETs, 745 materiales — más grande que
  `DBC_dim_set_material` (162 filas, 23 SETs) de esta nota. Confirmado como
  fuente válida.
- **La tarifa oficial también está en BigQuery**, no solo derivada de reportes:
  `D00_SANDBOX.proan_ZTSD_OV_COM_{H,BO,IA,L,A}_20260829`, sin duplicados de
  llave (a diferencia de `DBC_dim_comision_tarifa`, que sigue teniendo las 635
  combinaciones con más de un valor documentadas más abajo). Con esta fuente
  la cobertura de tarifa por división sube mucho respecto a la tabla "división
  por división" de esta nota: BO de 33.6% a 87.6%, H de 51.1% a 93.6%, IA de
  81.0% a 95.7%, A a ~100%.
- **`DBC_dim_almacen_oficina` (483 filas) no trae persona para Botana ni Abarrote:**
  0 de 93 filas de BO y 0 de 18 de A. No es un hueco nuevo — es el mismo hecho
  que esta nota ya documentaba de otra forma ("«DIVISIÓN BOTANA (BO)» no tiene
  personas" en la sección de los dos modelos de comisión), pero nunca se dijo
  explícito sobre esta tabla en particular.
- **Ese hueco de Botana sí se tapa en un 87% sin el cliente.** La hoja `Sheet1`
  de `DBC_dim_comision_tarifa` para división BO (la misma que ya gana como
  "vigente" en `dim_tarifa_v1`) trae persona en el 100% de sus 860 filas, 29
  personas distintas — incluye a Florentino en oficina `0011` con su nombre
  completo. De las 93 oficinas de BO sin persona en `DBC_dim_almacen_oficina`,
  81 sí la tienen ahí. Abarrote no tiene este atajo: no tiene ninguna fila en
  `DBC_dim_comision_tarifa` (usa su propio modelo, `DBC_dim_comision_abarrotes`,
  sin columna de persona).
- **Sí existe un maestro de proveedores con nombre en BigQuery**: `D20_DIMENSION.dm_vendors`
  (`razon_social`, `nombre_comercial`, RFC). No resuelve el mapeo comisionista↔proveedor
  por sí solo — cruzar por nombre contra las tablas de esta nota casi no funciona
  (nombres abreviados/apodos) — pero corrige la idea de que esa tabla no existe,
  repetida en el borrador técnico y en `hallazgos.md`.

## La conclusión de la lectura inicial (24 de agosto)

**Sus tablas están bien.** Cada división tiene su modelo, las tarifas cruzan
limpiamente por oficina, los SETs casan con los materiales, y Abarrotes cubre el
100% de lo que factura. Lo que falta no es calidad de datos: es **un trozo de
perímetro**.

**Seis almacenes —`BO28`, `BO01`, `H793`, `H723`, `H781`, `H159`— facturan
$696,7 M, el 50,8% de todo lo que se factura en las divisiones que el cliente
dice tener en operación.** Los otros ~200 pares almacén+oficina suman $675,3 M y
solo $15,2 M se quedan sin asignar: el 97,7% está mapeado.

Es decir: el hueco de CEDIS que arrastramos desde agosto y el hueco de tarifa
son **el mismo problema**, y se pregunta con una sola frase.

**Cuidado con la palabra «sin CEDIS»**, que en la primera versión de esta nota
llevaba a confusión: no significa que no se sepa de dónde son. Significa que
**no tienen fila en `dm_cedis`**, el catálogo contra el que cruzamos. Uno de
ellos se llama literalmente «CEDIS SAN JUAN» en el maestro de almacenes de SAP:
tiene CEDIS de sobra, lo que no tiene es entrada en nuestro catálogo.

Y no son seis casos iguales. Son **cinco de un tipo y uno de otro**:

| | almacenes | importe | qué les pasa |
|---|---|---|---|
| **Ausentes** | BO28, BO01, H793, H723, H781 | $663,7 M | Existen en SAP y facturan, pero no están ni en `dm_cedis` ni en ninguna tabla del cliente |
| **Desalineado** | H159 | $33,0 M | **Sí está** en sus tarifas (como «MEXICO CARL», Carlos de Anda, oficinas 0018 y 0188), pero SAP factura por la oficina 0001 |

A `H159` no hay que preguntarle si genera comisión: hay que cuadrar la oficina.

## Qué contestó el cliente, y qué desbloquea

| Pregunta del senior | Respuesta | Estado |
|---|---|---|
| ¿La comisión es por oficina/SET/caja? ¿Fuente concreta? | Sí, y se mantiene en tablas de SAP (TX GS01-GS02-GS03). Comparte los Excel con los que las alimenta | **Desbloqueado** |
| Diccionario centro-almacén-oficina completo | En la misma TX; comparte los Excel | Parcial: faltan cinco almacenes, y uno no cuadra de oficina |
| ¿La comisión depende del comisionista? | Se paga por esas relaciones, y hay comisionistas con tarifas distintas "por determinación de dirección" | **Desbloqueado** — y se ve en los datos |
| Qué divisiones contar | En operación: **H (DBC y PAN), BO, IA, A, L**. Las demás están configuradas pero las llevan otros departamentos | **Desbloqueado** |
| BWART de traspasos | **300-399**, y en croqueta también **100-199** | Desbloqueado, con reserva (ver abajo) |

**El filtro de divisiones cambia la foto del dashboard.** De los $2.036,4 M
facturados, solo **$1.372,0 M (67,4%)** son de divisiones en operación. Y el
hueco de CEDIS medido solo sobre ellas baja del 61,4% al **48,9%** — porque
divisiones enteras fuera de alcance (DG, DH, CM) están al 82-100% sin asignar y
estaban ensuciando el número.

## Los dos modelos de comisión

No hay uno, hay dos, y esto es lo que más cuesta ver leyendo los ficheros:

**A) Importe por caja, matriz SET × tipo de venta** (H, BO, IA, L). Cada fila es
centro + almacén + persona + oficina; las columnas son bloques de un SET
subdivididos por tipo de venta. **El vocabulario de tipos cambia por división**:

| división | tipos de venta que usa |
|---|---|
| H | PISO, RUTA, 1/2 MAYOREO, MAYOREO, ABASTOS |
| BO, IA | MENUDEO, MAYOREO |
| L | solo RUTA |

**B) Valor por material, sin SET** (A, abarrotes). Las columnas anchas por CEDIS
(`% A Sala`, `% A León`…) son solo formato: cada fila rellena la columna de su
propio CEDIS. El modelo real es un valor por almacén + oficina + material.

## División por división, con la cobertura medida

| división | facturado | cobertura de tarifa | dónde se pierde |
|---|---|---|---|
| BO | $622,5 M | 33,6% | BO28 + BO01 = $382 M |
| H | $589,3 M | 51,1% | H793 $235 M · H159 $31 M |
| IA | $62,4 M | 81,0% | H781 $5,6 M · H723 $3,8 M |
| L | $52,0 M | 53,2% | H723 $19,5 M |
| A | $45,8 M | **100%** | — |

**Huevo**: 353 combinaciones centro+almacén+oficina+SET, 45 personas, 4 SETs que
casan al 100% con el fichero de materiales. Trae las sociedades DBC y PAN con
las mismas tarifas duplicadas a propósito.

**Botana**: dos hojas que **no se contradicen, se complementan**. «Sheet1» tiene
29 personas, 10 SETs y ninguna oficina ambigua, pero cubre 27 almacenes;
«DIVISIÓN BOTANA (BO)» no tiene personas y tiene 6 oficinas ambiguas, pero cubre
32. Los cinco almacenes que solo trae la vieja (BO13, BO17, BO43) facturan $30 M
reales, así que **hacen falta las dos**.

**Croqueta y Leche**: limpias, sin una sola oficina ambigua ni tarifa duplicada.

**Abarrotes**: cinco hojas que son versiones sucesivas. La más nueva («3 Final
Carga Nueva Feb 2025») cubre el **100%** del facturado; las anteriores, 88,9%,
62,5% y 0%. De ahí sale una regla útil para todo lo demás: **cuál hoja está
vigente se puede medir por cobertura del facturado real, no adivinar**.

## El SET de producto: resuelto al 94,3%

`Set de Datos Materiales Desarrollos PROAN-Final.xlsx` es el export de GS03 que
llevábamos meses pidiendo. Una hoja por división, los SETs **en horizontal** en
bloques de dos columnas.

- **94,3% del facturado en operación tiene SET** ($1.294,3 M de $1.372,0 M).
- Por división: H 98,5%, A 98,0%, BO 97,6%, IA 97,6%, **L 0%**.
- El 0% de Leche no es un fallo de mapeo: **el fichero no trae hoja de L**. Pero
  su tabla de tarifas sí nombra los tres SETs (`LENTERA`, `LLIGTH`,
  `LDESLACTOZADA`) y en el flujo hay exactamente tres materiales de L
  (`18883`, `18884`, `18885`). Falta solo saber cuál es cuál.
- Ningún material aparece en dos SETs — que era el riesgo real, porque haría
  ambigua la tarifa.

## La tarifa se cruza por oficina, no por tipo de venta

Medido: cruzando por (centro, almacén, oficina, SET) e **ignorando la columna de
tipo de venta**, la tarifa es única en 351 de 353 combinaciones en Huevo, 728 de
728 en una hoja de Botana, y todas en Croqueta y Leche. La oficina ya determina
el tipo de venta, así que la matriz es redundante para calcular. Solo 11
combinaciones en total necesitan una regla de desempate.

Esto vale la pena recordarlo porque ahorra tener que reconciliar el vocabulario
de tipos del cliente (PISO/RUTA/MENUDEO…) con el de `dm_cedis`
(VTA EN RUTA/MAYOREO/MED MAYOREO/EXTRAS/VTA EN PISO), que no casan uno a uno.

## Traspasos: desbloqueado con reserva

BWART 300-399 y 100-199 en croqueta. Comprobado contra `sap_mseg`: con los CEDIS
de DBC como **destino** (`UMWRK_CentroDestino`) hay 3.713 líneas de BWART 301 y
68 de 309, $298 M, al 20 de agosto.

La reserva: `sap_mseg` está dominada por las plantas de producción (PANF, PAN3,
H3xx), no por los CEDIS, y hay **tres tablas** —`sap_mseg`, `sap_mseg_cerdo`,
`sap_mseg_croqueta`, esta última con 239k líneas y BWART mucho más variados
(101, 102, 161, 162, 201, 202, 261, 262, 301, 302, 309, 310, 343, 344, 351)—.
$298 M contra $2.224 M vendidos no cuadra como "todo lo que entra al CEDIS", así
que antes de construir la cuarta capa hay que entender el reparto entre las tres.

## Los nombres de los seis, y de dónde salen

Del maestro de almacenes de SAP: `D10_POSTPROCESSING.sap_T001L_YYYYMMDD`, campo
`LGOBE`, cruzado por **planta + almacén** (el mismo código significa cosas
distintas en plantas distintas: `H793` es «CEDIS SAN JUAN» en `DBC3` y
«MT AGUASCALIENTE» en `H7AG`). Son snapshots diarios, así que hay que leer el
último con comodín y no fijar una fecha.

| almacén | planta | nombre en SAP | importe en operación | ¿de dónde saldría su CEDIS? |
|---|---|---|---|---|
| `BO28` | DBCF | ALM. CENTRAL 2 | $343,6 M | **de ningún sitio** |
| `H793` | DBC3 | CEDIS SAN JUAN | $241,7 M | San Juan, por su nombre — **por confirmar** |
| `BO01` | DBCF | ALM. CENT. VUALA | $37,7 M | **de ningún sitio** — Vuala es la marca |
| `H159` | DBCF | DIS. MEXICO | $33,0 M | está en sus tarifas; falta cuadrar la oficina |
| `H723` | H7AG | ALM. CENTRAL | $24,1 M | **de ningún sitio** |
| `H781` | DBCF | ALM. CDMX 2 | $16,6 M | **CDMX 2 — lo dice el propio cliente** ✓ |

Los tres que se llaman «central» suenan a **almacén central y no a CEDIS
regional**, y son $405,4 M. Ahí no hay nada que deducir.

## Decisiones tomadas el 24/08

- **Si factura en una división en operación, es negocio de comisiones.** Eso
  mete a los cinco ausentes dentro del perímetro: no se pueden tratar como ruido.
- **`H793` se puede llamar San Juan**, con nota de confirmarlo con el cliente.
  Es deducción nuestra a partir del nombre en SAP, no dato suyo.
- **La oficina `0001` se queda fuera del fallback.** Con el filtro de divisiones
  puesto solo recuperaría $25,0 M (contra $418 M sin filtrar), y sigue
  colocando mal: mandaría a «Mexico 1» almacenes que la propia lista del cliente
  sitúa en Aguascalientes, León o Morelia, y `H723`, que está en planta `H7AG`.

## Lo que queda por preguntar

1. **`BO28`, `BO01` y `H723`** — $405,4 M sin CEDIS y sin tarifa, casi un tercio
   del negocio en operación. En SAP se llaman «ALM. CENTRAL 2», «ALM. CENT.
   VUALA» y «ALM. CENTRAL». ¿Generan comisión? ¿A qué CEDIS pertenecen?
2. **`H793`**: confirmar que «CEDIS SAN JUAN» es el CEDIS San Juan. $241,7 M.
3. **`H159`**: ellos lo tienen en las oficinas 0018 y 0188; SAP factura por la
   0001. ¿Cuál manda?
4. **Los tres materiales de Leche** (`18883`, `18884`, `18885`): cuál es entera,
   light y deslactosada. Sus SETs ya existen en la tabla de tarifas.
5. **HINDUSTRIA**: 111 casillas a 42,0 cuando el resto del huevo va de 0,35 a
   1,60. ¿Otra unidad?
6. **Botana**: cuál de sus dos hojas está vigente. Difieren en 619 casillas de
   624, y cada una cubre almacenes que la otra no tiene.

Lo que **ya no hace falta preguntar**, porque se resolvió leyendo sus propios
ficheros: el número de Abarrotes no es un porcentaje (ver abajo).

## Abarrotes: el número son pesos, no porcentaje

Lo resuelve `PRECIOS TORTILLAS 1.xlsx`, que a primera vista parecía un fichero
suelto. Su cabecera es `MATERIAL | DESCRIPCION | PRECIO A PAGAR | OFICINAS DE
VENTA`, y por cada oficina trae **dos** columnas: precio de venta y diferencia.
Para `110000012208` (TORTILLAS HARINA 1/2 KILO): precio a pagar 17,5, en
Irapuato 2 se vende a 18, diferencia **0,5** — y la hoja nueva del fichero de
comisiones de Abarrotes dice exactamente 0,5 para ese material en esa oficina.

Así que la comisión de Abarrotes es **el margen entre el precio de venta de la
oficina y el precio a pagar**, en pesos. El fichero se llama «Comisiones
Porcentajes» pero no contiene porcentajes. Y explica por qué las hojas viejas
van de 8 a 33: ahí están los **precios**, no las diferencias.

## Las cinco tablas que salen de todo esto

`scripts/tablas_cliente.py` lee la carpeta entera y produce cinco diccionarios
normalizados en `data/tablas_cliente/`. Sin `--cargar` solo escribe los CSV.

| tabla | filas | qué es |
|---|---|---|
| `DBC_dim_set_material` | 160 | SET ↔ material, con el código relleno a 18 para cruzar |
| `DBC_dim_comision_tarifa` | 3.426 | la tarifa por caja, en formato largo |
| `DBC_dim_comision_abarrotes` | 427 | el modelo aparte de abarrotes |
| `DBC_dim_almacen_oficina` | 483 | almacén + oficina + tipo de venta + comisionista |
| `DBC_dim_almacen_nombre` | 59 | almacén → nombre de CEDIS (31 de botana y 28 de huevo) |

La quinta salió de una hoja suelta que el clasificador había marcado como no
reconocida, y aportó dos cosas: **$20,9 M** del hueco y la confirmación de que
`H781` es CDMX 2 — que hasta entonces era una deducción nuestra.

**De las combinaciones de tarifa, 1.441 son únicas y 635 tienen más de un
valor** (619 de Botana, 16 de Huevo). Las únicas se pueden usar tal cual; las
otras no se resuelven a escondidas, se dejan a la vista y van al correo.

Regla de diseño del script, y no es cosmética: **nada depende del nombre de un
fichero ni de una hoja**. Cada hoja se clasifica por su contenido, la división
sale de su columna, y `fichero`/`hoja` viajan solo como rastro. Una hoja que no
encaje en ninguna forma conocida no se ignora en silencio: se avisa por
pantalla — que es justamente como apareció la quinta tabla.

## Trampas de lectura, para no repetirlas

Cada una de estas me hizo sacar una conclusión falsa antes de verla:

- **El nombre de la hoja no dice de qué división es.** Los ficheros son copias
  de una plantilla: el de Leche tiene su tabla en una hoja titulada «DIVISIÓN
  HUEVO (H)». Manda la columna `División` de cada fila.
- **El vocabulario de tipos de venta cambia por división.** Un extractor que
  solo conozca el de Huevo se traga las columnas de Mayoreo y descarta todas las
  de Menudeo, sin avisar.
- **La columna de almacén está unas veces en la primera fila de cabecera y otras
  en la segunda.**
- **El nombre del SET va encima de la columna de _denominación_**, no de la de
  material.
- **Los códigos de material vienen en dos formatos** (`12011` en huevo,
  `110000024242` en croqueta) y casan con los nuestros rellenando a 18 con
  ceros.
- **Los nombres de SET difieren entre el fichero de tarifas y el de materiales**
  (`BIG CHOCOLATE` ↔ `BIG_CHO`, `SWICH ROLL` ↔ `SW_ROLL`).
