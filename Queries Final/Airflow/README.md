# Airflow · carga incremental diaria

`DELETE` + `INSERT` acotado a una ventana. Estos son los archivos que se orquestan en el DAG.
Una carpeta por dataset destino; cada archivo es el **gemelo** del que tiene el mismo nombre
en `../Historico/<mismo dataset>/`.

> ## ⚠ La regla de los gemelos
>
> **Tocar un `.sql` de `../Historico/` obliga a tocar su gemelo de aquí en el mismo commit.**
>
> El `INSERT INTO` de abajo es **posicional** — no nombra columnas, van por orden:
>
> - si el número de columnas deja de coincidir → el DAG falla con `Inserted row has wrong
>   column count`. Molesto, pero se ve.
> - si el número coincide y **el orden no** → escribe datos mal, en silencio, sin error.
>
> El primer caso tumbó el DAG de Rentabilidad MAKA 6 días en julio de 2026. El segundo es el
> que da miedo.

## Plantilla

```sql
-- ============================================================================
-- INCREMENTAL · <TABLA>
-- ----------------------------------------------------------------------------
-- Lógica de negocio completa en ../../Historico/<dataset>/<archivo>.sql —
-- este archivo SOLO añade el patrón de refresco diario.
--
-- ALCANCE: últimos 12 meses completos de <columna de partición>.
--
-- Este INSERT es POSICIONAL: el orden es <lista de columnas> y tiene que
-- coincidir con el esquema que crea el gemelo. Si falla con "Inserted row has
-- wrong column count", la tabla tiene un esquema viejo: recrearla con el gemelo.
-- ============================================================================

DECLARE ventana_desde DATE DEFAULT DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH), MONTH);

DELETE FROM `proan-quantrue.<dataset>.<TABLA>`
WHERE <columna de partición> >= ventana_desde;

INSERT INTO `proan-quantrue.<dataset>.<TABLA>`
WITH ...
SELECT ...
WHERE <columna de partición> >= ventana_desde;   -- <- alcance incremental

ASSERT (SELECT COUNT(*) FROM `proan-quantrue.<dataset>.<TABLA>`
        WHERE <columna de partición> >= ventana_desde) > 0
  AS '<TABLA>: la ventana quedó vacía tras el refresco';
```

## Reglas que no se negocian

1. **`ventana_desde` vale lo mismo en los 7 archivos.** Si el gold usa una ventana más corta
   que la silver, conserva filas que la silver ya no tiene y las dos capas se separan sin que
   nadie lo note.
2. **`DBC_gold_conciliacion_producto_diario` corre después de `DBC_gold_conciliacion_factura_linea`**,
   no en paralelo: sale de esa gold, no de la silver. Si corre antes, recarga su ventana desde
   datos viejos.
3. **Las vistas no tienen gemelo aquí.** No se materializan, no hay nada que refrescar.
4. **Los snapshots con serie diaria se leen con `MAX(_TABLE_SUFFIX)`**, nunca con la fecha
   escrita a mano — si no, el DAG se queda con la foto del día que se escribió el SQL:

   ```sql
   FROM `proan-quantrue.D10_POSTPROCESSING.sap_MARM_*`
   WHERE _TABLE_SUFFIX = (SELECT MAX(_TABLE_SUFFIX)
                          FROM `proan-quantrue.D10_POSTPROCESSING.sap_MARM_*`)
   ```

   Aplica a `sap_MARM_*` y `proan_MAKT_Materials_*`. **No** aplica a la tarifa
   (`proan_ZTSD_OV_COM_*_20260829`), que es foto única y se queda fija a propósito.

## Orden en el DAG

Ver el árbol completo en [`../README.md`](../README.md). Resumen: las 2 silver en paralelo →
las 4 gold que salen de ellas en paralelo → `DBC_gold_conciliacion_producto_diario` al final.
`scripts/tablas_cliente.py --cargar` es precondición manual de todo, fuera del DAG.
