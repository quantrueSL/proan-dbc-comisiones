# Pendiente #8 — sap_mseg vs. MB51: validación intentada, inconclusa

Ejemplo real disponible (`backup/md/Reporte de comisiones 2025 - Modificaciones.md`,
hoja Traspasos): Sociedad `PAN`, Centro `PANF`, Almacén `H701`, semana
19-25 jul 2025 — `TRA_HSANJUAN=330,219.79`, `TRA_HPORTALES=13,882.73`,
`TRA_HINDUS=0`, `TRA_HRANCH=0`, total `344,102.52`.

**Aviso de alcance**: `PANF` es de la compañía `PAN`, no `DBC` — el propio
borrador (sección 2) ya señala que este ejemplo del cliente queda fuera del
alcance del proyecto. Sirve solo para probar si `sap_mseg` reproduce el
*patrón* de MB51, no como validación final de una cifra DBC.

## Lo que se probó

`sap_mseg` (esquema completo revisado, campos bilingües SAP: `WERKS_Centro`,
`LGORT_Almacen`, `BWART_TipoMovimiento`, `SHKZG_IndicadorDebitoCredito`,
`MENGE_Cantidad`, `DMBTR_ImporteMonedaLocal`, `BUDAT_MKPF_FechaDocumentoMaterial`,
entre ~80 campos más). Para `WERKS_Centro='PANF' AND LGORT_Almacen='H701'`
en esa semana, solo existen 5 combinaciones tipo de movimiento + indicador:

| BWART | Indicador | Filas | Cantidad (CS) | Importe |
|---|---|---|---|---|
| 601 | H (salida) | 4,561 | 4,543 | $1,467,215.02 |
| 301 | S (entrada) | 11 | 4,408 | $1,414,087.56 |
| 261 | H (salida) | 3 | 14 | $6,427.03 |
| 309 | H | 2 | 2 | $1,077.92 |
| 309 | S | 2 | 2 | $1,077.92 |

`301/S` (traspaso recibido, S = débito = entrada en la convención SAP
estándar) es el candidato lógico a "traspasos entrada". Su detalle por
material (solo 3 materiales, 11 líneas):

| Material | Cantidad (CS) | Importe |
|---|---|---|
| 000000000000012752 | 3,000 | $731,597.44 |
| 000000000000012011 | 1,366 | $662,039.61 |
| 000000000000012022 | 42 | $20,450.51 |

**Ninguna combinación de estos números (total, ni por material, ni en
cantidad ni en importe) reproduce 344,102.52, 330,219.79 ni 13,882.73.**

## Por qué es inconcluso, no una prueba en contra de sap_mseg

1. No se sabe con certeza qué código(s) `BWART` usa el reporte MB51 del
   cliente para "traspasos" — se asumió `301/S` por convención SAP estándar,
   pero sin confirmación del cliente podría ser otro código o una
   combinación de varios.
2. No se puede aislar por SET/marca (San Juan, Portales, etc.) sin GS03 —
   así que aunque el `BWART` correcto se identificara, seguiría sin poderse
   reproducir el desglose por SET, solo un total agregado.
3. El ejemplo es de compañía `PAN`, no `DBC` — cualquier diferencia de
   configuración de movimientos entre ambas compañías (poco probable pero no
   descartable) invalidaría la comparación igual.

## Conclusión

Pendiente #8 sigue abierto. La causa ya no es solo "falta correr la
validación" — es que **faltan dos datos del cliente para poder validar de
verdad**: (a) qué código(s) de movimiento (`BWART`) corresponden a
"traspasos" en su MB51, y (b) GS03 para el desglose por SET. Vale la pena
añadir (a) a la lista de preguntas pendientes (sección 15.2 del borrador) —
hoy no está ahí explícitamente.
