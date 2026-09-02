# Borrador de correo — Comisiones DBC (seguimiento de pendientes)

_Ajustar destinatario, saludo y firma antes de enviar._

> **Antes de enviar (nota del 1 de septiembre de 2026): la mitad de esta lista ya se
> resolvió el 24-25 de agosto.** El párrafo de GS03/`ZSDFI_001` (líneas 15) ya no
> aplica — el cliente mandó ambos. Lo de comisionista↔oficinas (línea 17) sigue
> vigente, pero ahora con más detalle: ver
> `Datos/Comisiones_DBC_Borrador_Tecnico.md` sección 16.3 (el hueco real es solo
> en Botana y Abarrote, y en Botana se pudo tapar la mayor parte sin el cliente).
> No mandar este correo sin reescribir esos párrafos.

---

**Asunto:** Comisiones DBC — algunos pendientes para seguir avanzando

Hola [nombre], ¿cómo estás?

Espero que todo vaya muy bien por allá. Te escribo para darte un avance del proyecto de comisiones y el dashboard de DBC: con los reportes que nos compartieron de la semana del 19 al 25 de julio pudimos resolver bastantes de las dudas que traíamos del correo anterior, así que muchas gracias por eso, nos ayudó mucho.

Para poder seguir avanzando con la siguiente etapa, nos van quedando algunos pendientes. Te los dejo organizados para que sea más fácil revisarlos con quien corresponda de tu equipo:

Sobre los productos y las tarifas, todavía nos falta el export de GS03 con la definición de los SETs de producto (o sea, cómo se agrupan los materiales por marca/línea en cada división) — este es el que más nos urge, porque sin él no podemos calcular la comisión real todavía. También nos faltaría el export de la tabla de tarifas ZSDFI_001; ya sabemos que es la fuente correcta gracias a su propio reporte, solo nos falta el dato completo.

Sobre los comisionistas, nos ayudaría mucho tener la agrupación completa y ya confirmada de qué comisionista corresponde a qué oficinas de venta. Tenemos algunos ejemplos sueltos del reporte que nos pasaron (por ejemplo, vimos que Martha Leticia corresponde a la oficina 0019-0092), pero en el mismo reporte esa parte venía marcada como pendiente, así que imaginamos que ustedes tampoco la tienen del todo cerrada — cualquier avance que tengan nos sirve. También necesitaríamos saber qué rango de número de proveedor identifica a los comisionistas en SAP, y cada cuánto se les liquida (¿semanal, mensual?).

Nos surgieron también un par de dudas sobre el alcance de la información. Notamos que hay otras divisiones (L, DG, CE, CP, CM) que no aparecen en los reportes que nos han compartido, que solo cubren Huevo, Botana, Abarrote y Alimento — ¿estas otras divisiones aplican también a DBC en algún CEDIS o almacén, o son de otras empresas del grupo y quedan fuera de esto? Y por otro lado, encontramos una planta (DBC1) con un almacén (DG01) que no logramos ubicar en nuestro catálogo de CEDIS — ¿podría ser "Derivados de Ganado" de DBC? Nos ayudaría que nos confirmaran cómo debería mapearse.

Hay dos cosas puntuales en las que sí necesitamos su ayuda para decidir cómo proceder, porque son casos que no podemos resolver solo revisando los datos: por un lado, encontramos 36 casos donde un mismo almacén y oficina aparecen relacionados a la vez con dos sectores distintos ("Huevo/Croqueta" y "Tortilla"), y no sabemos cómo deberíamos repartir eso. Por otro lado, también hay facturas que abarcan dos almacenes distintos a la vez (mismo centro y oficina) — en esos casos, ¿cómo debería repartirse el monto cobrado entre ambos almacenes para el cálculo de la comisión?

Por último, retomamos una pregunta que dejamos abierta en el correo pasado y que aún no nos han contestado: ¿hay algo más que debamos tener en cuenta y que no hayamos contemplado hasta ahora?

Sé que es una lista larga, así que si en algún momento es más práctico platicarlo por llamada en vez de por correo, con todo gusto la agendamos. Muchas gracias de antemano por el apoyo.

Saludos,
[firma]
