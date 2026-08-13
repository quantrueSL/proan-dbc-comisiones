# PRECIOS_AMPLIADO — no explica el gap de precio de la sección 4.3

`D60_REPORTING.PRECIOS_AMPLIADO` sí tiene datos para `company_code = 'DBC'`,
pero **no sirve para explicar el gap histórico vendido→facturado** de la
sección 4.3 (11.05%, atribuido a descuentos/rebates aplicados solo al
facturar):

- Solo cubre **2026-07-11 a 2026-08-10** (ventana móvil de ~30 días) — no
  llega a enero 2026, que es donde está medido el gap original.
- Es una tabla de **detección de anomalías de precio en vivo**
  (`median_30d`, `IQR`, `Status` Normal/Leve/Media/Grave, columnas de
  usuario que revisó cada caso) — compara el precio facturado contra una
  mediana móvil de 30 días, no contra el precio de venta original (`NETWR`
  de `sap_VBAP`). Es un concepto distinto al del gap de la sección 4.3.

Dato aparte, sin relación directa con el pendiente: de 125,859 líneas DBC en
esa ventana, la gran mayoría (111,959) son "Normal", y muy pocas (23) caen en
"Grave" — sugiere que el proceso de precios normal está bastante controlado;
no es evidencia de nada relevante para el pendiente de la sección 4.3, solo
contexto.

**Conclusión**: esta vía no resuelve el pendiente. Sigue siendo una pregunta
abierta para negocio/cliente (ya marcada como "no bloqueante" en el
borrador), y esta tabla es una herramienta operativa distinta que ya existe
en el grupo — puede valer la pena mencionarla al equipo como referencia, sin
que forme parte del pipeline de comisiones.
