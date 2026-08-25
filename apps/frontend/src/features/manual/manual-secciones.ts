// Índice del manual, en un solo sitio.
//
// Sin "use client": lo usa el índice lateral (cliente, para saber qué apartado
// se está mirando) y lo usan los propios apartados (servidor) para poner su
// `id`. Si la lista viviera en dos lados, el índice acabaría enlazando a un
// ancla que ya no existe y nadie se daría cuenta.

export type Seccion = { id: string; titulo: string };

export const SECCIONES: Seccion[] = [
  { id: "que-es", titulo: "Qué es esto" },
  { id: "problema", titulo: "El problema" },
  { id: "recorrido", titulo: "El recorrido" },
  { id: "modulos", titulo: "Los módulos" },
  { id: "alcance", titulo: "Qué entra y qué no" },
  { id: "fases", titulo: "Las tres líneas" },
  { id: "grafica", titulo: "Leer la gráfica" },
  { id: "vendido", titulo: "Vendido va atrás" },
  { id: "sin-asignar", titulo: "«Sin asignar»" },
  { id: "unidades", titulo: "Las cantidades" },
  { id: "filtros", titulo: "Los filtros" },
  { id: "falta", titulo: "Qué falta" },
  { id: "glosario", titulo: "Glosario" }
];
