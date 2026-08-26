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
 * venta). Se asignan SIEMPRE en orden fijo, nunca cíclicamente: si una categoría
 * desaparece al filtrar, las demás no pueden cambiar de color.
 *
 * SON CINCO PORQUE HAY CINCO TIPOS DE VENTA. Eran cuatro, y con cuatro el donut
 * de comisiones repetía color: VTA EN RUTA y EXTRAS salían del mismo azul, así
 * que la leyenda tenía dos entradas con el mismo tono. El quinto (`#0c9edc`) no
 * se eligió a ojo — se buscó con el validador de la guía de visualización sobre
 * todo el espacio OKLCH, y es de los pocos que caben: llena el hueco de tono que
 * le faltaba a la paleta (había índigo, verde, naranja y magenta, ningún azul
 * cielo), tiene el croma en el mismo rango que los otros cuatro, y pasa el
 * contraste contra la superficie. Sobre pares adyacentes las cinco
 * comprobaciones pasan limpias.
 *
 * SI ALGÚN DÍA APARECE UN SEXTO TIPO, la respuesta NO es añadir otro color a
 * ojo: casi no queda sitio en el espacio validado. Es agrupar la cola en «Otros
 * tipos», que es lo que manda la guía.
 *
 * La separación bajo daltonismo del par magenta↔verde se queda en la banda
 * mínima (ΔE 6,8 comparando todos los pares entre sí, no solo vecinos), y eso ya
 * pasaba con cuatro colores. Es legal porque el color no es la única pista: la
 * leyenda lleva el nombre y el importe al lado de cada punto, y entre trozos del
 * donut hay 2 px de hueco. Si alguien quita esas dos cosas, el aviso pasa a ser
 * un fallo.
 */
export const PALETA_CATEGORIAS = ["#5f62d0", "#12a074", "#cf7a22", "#b5518f", "#0c9edc"];

/** Gris para el grupo sin asignar: no es una categoría, es la ausencia de una. */
export const COLOR_SIN_ASIGNAR = "#9a948c";
