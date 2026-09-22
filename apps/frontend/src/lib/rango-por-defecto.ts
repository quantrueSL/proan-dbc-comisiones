/**
 * Rango de fechas por defecto compartido entre Comisiones y Flujo de
 * producto -- ver el comentario en cada `page.tsx` para el porqué de
 * compartirlo: cambiar de pantalla con un periodo distinto en cada una
 * confunde más de lo que ayuda.
 *
 * Últimos 6 meses hasta hoy (2026-09-22, decisión de Silvana: antes era "todo
 * el año", sin más fundamento que igualar las dos pantallas). 6 meses porque
 * diluye un rezago de fase como el de "vendido" (~3 semanas sin filas nuevas
 * en sap_VBAP porque la ingesta se refresca a mano sin alerta, ver
 * data/notas/hallazgos.md) a una proporción parecida a la que tenía con el
 * año completo, sin arrastrar 8-9 meses de datos en cada carga.
 *
 * `desde` es SIEMPRE día 1 de un mes, no "hoy menos 180 días": restar días
 * corta los meses intermedios a la mitad (con hoy 22-sep, marzo aparecería
 * desde el día 22, como si faltaran sus primeros 21 días) y eso es
 * indistinguible de un hueco real de datos. El mes en curso (parcial, porque
 * `hasta` es hoy) cuenta como uno de los 6 -- solo el borde vivo se ve
 * parcial, ningún mes de en medio.
 */
export function rangoPorDefectoCompartido(hoy: Date = new Date()): { desde: string; hasta: string } {
  const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 5, 1));
  return {
    desde: desde.toISOString().slice(0, 10),
    hasta: hoy.toISOString().slice(0, 10)
  };
}
