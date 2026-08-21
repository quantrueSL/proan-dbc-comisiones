// Agrupación de la serie del flujo: de filas por día a grupos por día, semana o
// mes, con el dominio del eje ya resuelto.
//
// Vive aparte de flujo-chart.tsx y SIN "use client" por dos razones. La primera
// es la misma que en fases.ts: un módulo marcado como cliente no puede exportar
// valores que no sean componentes sin romper el manifiesto de React Server
// Components. La segunda es que esto es la única parte de la gráfica que se
// puede comprobar sin navegador —no hay jsdom en las dependencias—, y es justo
// la parte donde un error no se ve: si el grano se elige mal, la gráfica sigue
// dibujándose perfecta pero cada barra vale siete veces lo que parece.
//
// LA REGLA QUE NO SE PUEDE PERDER: un valor `null` es "no aplica" y se queda en
// `null`. Hoy las cajas solo existen en la fase facturado, y convertir eso en un
// cero diría que se facturaron cero cajas. Sumar sí es sumar: dos días con dato
// dentro de la misma semana se suman.

import { FASES } from "@/features/flujo-producto/fases";

export type Grano = "dia" | "semana" | "mes";

/** Del más fino al más grueso: se prueban en este orden y gana el primero que
 *  quepa en el ancho disponible. */
const GRANOS: Grano[] = ["dia", "semana", "mes"];

export const NOMBRE_GRANO: Record<Grano, string> = {
  dia: "diaria",
  semana: "semanal",
  mes: "mensual"
};

/** Lo que se escribe en la leyenda. En grano diario no se dice nada: es lo que
 *  cualquiera da por supuesto al ver una serie de días. */
export const AVISO_GRANO: Record<Grano, string | null> = {
  dia: null,
  semana: "agrupado por semana",
  mes: "agrupado por mes"
};

const MES_CORTO = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" });
const MES_LARGO = new Intl.DateTimeFormat("es-MX", { month: "long", timeZone: "UTC" });

export function diaCorto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

/** Fechas en UTC a pelo: las claves son cadenas ISO, no instantes, y pasar por
 *  la zona local del navegador movería un día de sitio según el huso. */
function masDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

/** Lunes de la semana de `iso`. La semana empieza en lunes, no en domingo. */
function lunesDe(iso: string): string {
  const dia = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return masDias(iso, -((dia + 6) % 7));
}

export function claveDe(iso: string, grano: Grano): string {
  if (grano === "dia") return iso;
  if (grano === "semana") return lunesDe(iso);
  return iso.slice(0, 7);
}

function primerDiaDelMes(clave: string): Date {
  return new Date(`${clave}-01T00:00:00Z`);
}

/** Etiqueta del eje X. El año solo aparece en los meses y solo si el rango
 *  cruza de año: "ene" repetido dos veces sin año no se puede leer. */
export function etiquetaEje(clave: string, grano: Grano, conAnio: boolean): string {
  if (grano === "mes") {
    const mes = MES_CORTO.format(primerDiaDelMes(clave)).replace(".", "");
    return conAnio ? `${mes} ${clave.slice(2, 4)}` : mes;
  }
  return diaCorto(clave);
}

/** Rótulo de la ficha flotante: dice de qué periodo son los números que hay
 *  debajo, para que una barra semanal no se lea como un día. */
export function rotuloGrupo(clave: string, grano: Grano): string {
  if (grano === "dia") return clave;
  if (grano === "semana") return `Semana del ${diaCorto(clave)} al ${diaCorto(masDias(clave, 6))}`;
  const mes = MES_LARGO.format(primerDiaDelMes(clave));
  return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} ${clave.slice(0, 4)}`;
}

/** Redondea el extremo del eje a algo legible en vez de al máximo exacto. */
export function techo(max: number): number {
  if (max <= 0) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / (magnitud / 2)) * (magnitud / 2);
}

/**
 * El grano más fino que cabe. `pasoMinimo` es lo que ocupa un grupo de barras
 * con su separación, y lo pone la gráfica: aquí no se sabe de píxeles.
 */
export function granoQueCabe(fechas: string[], anchoUtil: number, pasoMinimo: number): Grano {
  for (const grano of GRANOS) {
    const grupos = new Set(fechas.map((fecha) => claveDe(fecha, grano))).size;
    if (grupos === 0 || anchoUtil / grupos >= pasoMinimo) return grano;
  }
  return "mes";
}

export type FilaSerie = { fecha: string; fase: string };

export type Serie = {
  claves: string[];
  /** fase → valor por grupo, en el orden de `claves`. `null` = sin dato. */
  series: Map<string, (number | null)[]>;
  grano: Grano;
  techoEje: number;
  /** Cero salvo que haya valores negativos, que existen: hay días de facturado
   *  en negativo por notas de crédito. Con el suelo a cero, esas barras se
   *  salían del área de dibujo sin avisar. */
  pisoEje: number;
};

export function agruparSerie<T extends FilaSerie>(
  filas: T[],
  valorDe: (fila: T) => number | null,
  grano: Grano
): Serie {
  const claves = Array.from(new Set(filas.map((f) => claveDe(f.fecha, grano)))).sort();
  const indice = new Map(claves.map((clave, i) => [clave, i]));

  const series = new Map<string, (number | null)[]>(
    FASES.map((fase) => [fase, claves.map(() => null)])
  );
  for (const fila of filas) {
    const valores = series.get(fila.fase);
    const i = indice.get(claveDe(fila.fecha, grano));
    if (!valores || i === undefined) continue;
    const valor = valorDe(fila);
    if (valor === null) continue; // "no aplica" sigue siendo hueco, no cero
    valores[i] = (valores[i] ?? 0) + valor;
  }

  const todos = Array.from(series.values())
    .flat()
    .filter((v): v is number => v !== null);
  const maximo = todos.length ? Math.max(...todos) : 0;
  const minimo = todos.length ? Math.min(...todos) : 0;

  return {
    claves,
    series,
    grano,
    techoEje: techo(Math.max(0, maximo)),
    pisoEje: minimo < 0 ? -techo(-minimo) : 0
  };
}
