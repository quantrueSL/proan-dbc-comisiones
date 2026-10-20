# Conciliación por cortes — resumen de la sesión (14 oct 2026)

Pestaña nueva de pruebas (`/conciliacion-cortes`), junto a la de Conciliación, que no se tocó.
Detalle de las mediciones: [medicion_cortes_conciliacion_2026-10-14.md](medicion_cortes_conciliacion_2026-10-14.md).

## La idea

Quien concilia parte de un pago fijo (lo que se le pagó al comisionista) y busca los cobros que lo
justifican. En vez de una semana rígida, cada pago tiene una **ventana de fechas** que se ajusta moviendo
los **cortes** (el borde que comparten dos pagos contiguos). El sistema sugiere el ajuste cuando existe,
y al **consolidar** un pago se congelan sus cortes para que no vuelvan al default.

## Decisiones tomadas

- **Pagos:** se identifican por el documento de SAP (`BUKRS|GJAHR|BELNR`), nunca por el texto de BSAK.
  El texto solo propone la ventana por defecto.
- **Ventanas:** son cortes entre pagos contiguos. Los huecos y traslapes se avisan, no se bloquean.
- **Vista:** el mes como lista de trabajo; el panel de un pago muestra a sus vecinos (±1 pago, ampliable).
- **Estado del usuario en Firestore** (base nueva `dbc-comisiones`, colecciones `conc_*`). BigQuery sigue
  de solo lectura. Se guarda contra el `pago_id`, con versión por fila (conflicto = 409).
- **Sin pedir motivo** al consolidar o reabrir. Quién puede reabrir: sin definir.
- **Edición solo con rol `admin`** (hoy los roles son admin / viewer).
- **Consolidar** va de izquierda a derecha por comisionista; "volver al default" no aplica a lo consolidado.

## Qué se midió (ene–sep 2026, 4,280 pagos)

- 25% cuadra, 10% se explica moviendo un borde ≤3 días (casi todo un solo día), **47% sin explicación**.
- Un pago de pantalla = un documento RE (1 línea, 1 texto, 1 compensación). 92% de las ventanas son
  contiguas con la anterior; solo 60% son sábado-viernes; 59 documentos sin ventana legible.
- **DBC-Huevo + Abarrotes:** los exactos pasan de 192 a 339 de 807 y el total de -24.6% a -4.0%.
- **PAN-H y DBC-BO:** no es desfase, ventana, factura suelta ni producto. 12 comisionistas concentran ~69%
  de la diferencia y dos LIFNR (0000014917, 0000016385) no tienen calculado. Parece comportamiento propio
  de cada comisionista.
- **Último día del mes:** sacarlo del pago de su semana sube los pagos que cuadran de 1% a 31% en los casos
  con cobros ese día. A qué pago va después no se sostiene con los datos. Efecto total: cuadran
  1,072 → 1,290 y las sugerencias de borde 443 → 211.
- El calculado por oficina y por `comisionista_id` es idéntico en los 4,079 pagos comparables.

## Qué se construyó

| Fase | Qué | Dónde |
|---|---|---|
| 1 | Tabla de pagos por documento (BigQuery) | `Datos/sql/v1_conciliacion_pago_documento.sql` (ZZ_PRUEBAS) y gemelos en `Queries Final/Historico` y `Airflow` (D60, para la migración) |
| 2 | Motor puro: ventanas, estados, sugerencias, cierre de mes, congelado | `conciliacion_cortes_engine.py` |
| 3 | Pestaña de solo lectura: lista del mes, panel con línea de tiempo, detalle por producto | `conciliacion_cortes_service.py`, endpoints `/v1/comisionesbi/cortes/*`, `src/features/conciliacion-cortes/` |
| 4 | Edición con Firestore: aplicar/descartar sugerencia, mover corte (clics agrupados), restablecer, historial | `conciliacion_cortes_estado.py`, ruta `app/api/comisionesbi/cortes/editar/[accion]` |

Comprobado: 200 pruebas de backend, 212 de frontend, y un recorrido completo en el navegador contra
Firestore real (los documentos de prueba se borraron). Cifras reproducidas: el motor da los mismos
resultados que la medición.

## Cómo correrlo (Docker de desarrollo)

- Tras agregar la dependencia de Firestore hubo que reconstruir la imagen del backend:
  `docker compose -f deploy/docker-compose.dev.yml build dbc-comisionesbi-dev` y levantarlo de nuevo.
  El hot-reload solo recarga código, no dependencias.
- Variables nuevas en `deploy/cloudrun/service.yaml`: `CONCILIACION_FIRESTORE_DATABASE_ID` y
  `CORTES_CACHE_TTL_SECONDS`.
- La tabla se lee de `ZZ_PRUEBAS` (igual que la pestaña vieja). Al migrar a D60 hay que repuntar las
  constantes `_TABLA_*` del servicio y borrar el script de `Datos/sql`.

## Pendiente (a 14 oct; el estado vigente está al final, a 20 oct)

1. **Fase 5 — Consolidar:** congelar cortes con foto del pago, aviso de cambio posterior, reabrir con
   advertencia, consolidar en lote, avisar ajustes huérfanos (documento que ya no está en BSAK) y los 59
   pagos sin ventana.
2. **Fase 6 — Excel por ventana** (con columna "Pago asignado").
3. **Último día del mes:** confirmar a qué pago va exactamente (¿por comisionista?) y poder asignar días
   sueltos a un pago que no sea contiguo.
4. **Sugerencia de Abarrotes** para DBC-H (sube los exactos de 24% a 42%), y cómo mostrar el 47% sin
   explicación (diferencia de monto, sobre todo PAN-H y DBC-BO).
5. **Ajustes de la pantalla:** texto largo de algunas sugerencias, flechas para bordes sueltos
   (extremos, huecos, traslapes), primera carga lenta en frío (~20 s).
6. **Preguntas al cliente:** quién puede reabrir, acuerdos especiales de los ~12 comisionistas
   concentrados, los dos LIFNR sin calculado.
7. Correr los DDL de `D60` y repuntar constantes cuando se haga la migración.

## Actualización posterior (mismo día)

- **Rediseño aplicado:** tabla por comisionista (se abre por división), KPIs en cajitas, panel fijo con navegación entre pagos,
  Huevo + Abarrotes de DBC como un solo pago, documento y texto de SAP bajo el nombre.
- **Fase 5 hecha:** consolidar y reabrir (solo admin), aviso si los datos cambian después de consolidar, "Consolidar lo que cuadra"
  en lote (izquierda a derecha, se detiene en el primer pago que no cuadra), ventana a mano para pagos sin texto legible y
  limpieza de ajustes huérfanos. Quedan la Fase 6 (Excel) y la 7.

## Estado a 20 de octubre

**Hecho desde el 14 de octubre**
- **Fases 1 a 5 completas** (commits `f6b5151` backend y `1a94c2f` frontend): consolidar y reabrir, "Consolidar lo que cuadra" en lote
  (izquierda a derecha, hasta el primer pago que no cuadra), ventana a mano para pagos sin texto legible, limpieza de ajustes huérfanos
  y aviso "⚠ Cambió" si los datos cambian después de consolidar.
- **Ventanas estándar:** la ventana por defecto es el texto acomodado a sábado-viernes y fin de mes, sin traslapes (cuadran
  1,290 → 1,316, traslapes 56 → 0). Sección 8 de la nota de mediciones.
- **Cierre de mes:** el último día con cobros de cada mes sale de su pago y queda como hueco "Cierre de mes, sin asignar". Una sugerencia
  asigna el bloque de fin de mes a un pago posterior solo si lo deja exacto (nunca automática; se guarda en `dias_asignados`). Mediciones
  en las secciones 9 a 12: 105 casos con el último día solo, 20 más con colas de 2-3 días.
- **Pantalla:** rediseño (tabla por comisionista, KPIs, panel fijo), documento SAP y texto bajo el nombre, "Pago anterior/siguiente" que
  cruzan meses, flechas ◀ ▶ para desplazar semanas, "Desplegar todo", mes por defecto = mes de hoy (o el anterior si no tiene pagos).
  Backend: la lista y el lote aceptan `desde`/`hasta` además del mes (sin commit).
- **Despliegue de prueba:** `bash deploy/cloudrun/deploy-dev.sh` (servicio `plataforma-comisiones-dbc-dev`, ver `deploy/cloudrun/README.md`).
  Primer intento falló por un error pasajero de `next/font`; hay que reintentar.
- **Roles:** para editar hace falta `admin` en `lists/dbc_comisiones_acceso`; el valor `generico` de Mailing-lists cuenta como viewer (LOGIN.md §3).

**Falta (plan al 20 de octubre, en orden propuesto)**
1. Cerrar lo ya hecho: commit de semanas con corte de fin de mes, orden fijo de divisiones y `desde`/`hasta`; reintentar el despliegue dev y que el senior lo revise (pendiente su explicación de las flechas).
2. HECHO (sin commit) — Cierre de mes a mano, sin sugerencia (bloque "Cierre de mes" del panel, endpoint `asignar-dias`): poder elegir los días de cierre (el bloque libre) y asignarlos a cualquier pago, con el mismo `dias_asignados` y "Volver a la ventana estándar" para deshacer. Hoy solo se asigna aplicando la sugerencia exacta; los casos sin exacto (el 47%) no tienen cómo.
3. HECHO (sin commit) — Fase 6: botón "Descargar Excel" en el panel de cada pago (junto a las pestañas), un libro por pago con el nivel de la pestaña vieja: hojas Pago, Conciliación (por producto), Detalle diario y Detalle de factura, con columna "Pago asignado" y motivo (ventana / cierre asignado). Endpoint `exportar` (Abarrotes dentro de Huevo en DBC). No hay Excel general de la lista: se quitó por ruido.
4. Comodidad de trabajo: botón que aplique en bloque las sugerencias de borde y de cierre de un mes (con vista previa); flechas para bordes sueltos; textos de sugerencias más cortos; aviso de solo lectura más claro ("tu rol es viewer…"); carga en frío ~20 s.
5. Fase 7: mostrar el 47% sin explicación (diferencia de monto en ~12 comisionistas de PAN-H/DBC-BO), reglas por comisionista, Firestore → BigQuery, destino de la pestaña vieja.
6. Migración a D60: correr los DDL y repuntar `_TABLA_*` del servicio.
7. Preguntas al cliente: quién puede reabrir, cómo se paga el último día del mes, acuerdos especiales de los ~12 comisionistas, los dos LIFNR sin calculado (0000014917 y 0000016385).
8. Para después: sugerencia combinada de un clic para el cierre (bloque + borde) si el flujo en dos pasos resulta lento.
