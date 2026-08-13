# Pendiente #1 (36 combos almacén+oficina) — en realidad es 1 caso real

Contexto: `Datos/Comisiones_DBC_Borrador_Tecnico.md`, sección 9 pendiente #1 y
sección 15.2 punto 9, describe 36 combinaciones almacén+oficina en `dm_cedis`
que mapean a dos sectores ("Huevo (H) y Croqueta (IA)" vs "Tortilla (A)"),
resueltas hoy en `dim_cedis_v1` (`Datos/sql/v1_flujo_producto_dbc.sql:92-104`)
con una regla provisional arbitraria (primer sector alfabético).

## Lo que se encontró

Consultando `dm_cedis` directo (solo catálogo — almacén/oficina/sector/cedis/
tipo_venta, nada confidencial), agrupando los 36 combos por `almacen+oficina`
y viendo cuántos valores distintos de `cedis` y `tipo_venta` produce cada
sector:

**En 35 de los 36 combos, `cedis` Y `tipo_venta` son idénticos sin importar
qué sector gane el desempate.** La ambigüedad de `sector` no se propaga al
resultado — es inofensiva en la práctica, aunque la regla de desempate sea
arbitraria.

**El único combo con conflicto real: almacén `H717`, oficina `0122`
(Celaya)**:

| Sector | `cedis` | `tipo_venta` |
|---|---|---|
| Huevo (H) y Croqueta (IA) | Celaya Agustin | EXTRAS |
| Tortilla (A) | Celaya Genaro | VTA EN RUTA |

Esto coincide con el hallazgo de la ronda anterior (cruce contra los excels
de `backup/md/`): "Agustin" (oficinas `0145-0012-0083`) y "Genaro" (oficina
`0122`) son dos comisionistas de Celaya que el borrador no tenía
documentados. La oficina `0122` parece estar genuinamente compartida entre
ambos — coherente con que `dm_cedis` la vea bajo dos CEDIS distintos según
sector.

## Por qué importa

El pendiente de negocio real no es "cómo repartir 36 casos" — es una
pregunta mucho más chica y concreta: **¿la oficina 0122 de Celaya se reparte
entre Agustin y Genaro, y si es así, es por tipo de venta (EXTRAS vs VTA EN
RUTA) o de otra forma?** Vale la pena replantear así el punto 9 de la
sección 15.2 en el próximo correo al cliente, en vez de la formulación
genérica actual.

## Qué NO se tocó

No se modificó `dim_cedis_v1` ni ninguna parte de `v1_flujo_producto_dbc.sql`
-- el borrador dice explícitamente que ese SQL ya está validado y no debe
tocarse salvo error nuevo. Esto es solo un hallazgo de análisis; la regla
provisional actual sigue en pie y de hecho produce el resultado correcto en
35 de los 36 casos.
