// Las tres fases del flujo: orden, nombre y color.
//
// Vive aparte y SIN "use client" a propósito. Estas constantes las usan tanto
// componentes de cliente (la gráfica, el workspace) como de servidor (la página
// del manual), y sacar un valor que no es un componente de un módulo marcado
// como cliente rompe el manifiesto de React Server Components:
//   Could not find the module "…/flujo-chart.tsx#COLOR_FASE#vendido"
//
// La paleta está validada con el script de la guía de visualización contra
// fondo blanco: banda de luminosidad, croma mínimo, separación para daltonismo
// (ΔE 9,3 protan / 11,1 tritan) y contraste. Son los tonos de marca aclarados
// hasta que pasan; los originales fallaban.

export const FASES = ["vendido", "facturado", "cobrado"] as const;

export type Fase = (typeof FASES)[number];

export const COLOR_FASE: Record<string, string> = {
  vendido: "#5f62d0",
  facturado: "#12a074",
  cobrado: "#cf7a22"
};

export const ETIQUETA_FASE: Record<string, string> = {
  vendido: "Vendido",
  facturado: "Facturado",
  cobrado: "Cobrado"
};

/**
 * Paleta categórica para dimensiones con pocas categorías (el donut de tipo de
 * venta). Cuatro colores, también validados: pasan las cinco comprobaciones sin
 * avisos. Se asignan SIEMPRE en orden fijo, nunca cíclicamente: si una categoría
 * desaparece al filtrar, las demás no pueden cambiar de color.
 */
export const PALETA_CATEGORIAS = ["#5f62d0", "#12a074", "#cf7a22", "#b5518f"];

/** Gris para el grupo sin asignar: no es una categoría, es la ausencia de una. */
export const COLOR_SIN_ASIGNAR = "#9a948c";
