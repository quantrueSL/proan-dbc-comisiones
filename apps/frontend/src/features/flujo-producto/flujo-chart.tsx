"use client";

// Serie diaria de vendido / facturado / cobrado.
//
// SVG a mano y sin librería de gráficas: no hay ninguna en las dependencias y
// meter uno de los paquetes habituales por tres líneas serían cientos de KB en
// el navegador para algo que cabe en un fichero.
//
// LO MÁS IMPORTANTE DE ESTE COMPONENTE: un día sin dato deja HUECO en la línea,
// nunca un cero. "Vendido" se corta el 20/07/2026 porque sap_VBAP no recibe
// datos (data/notas/hallazgos.md); dibujarlo como cero diría que ese día no se vendió
// nada, que es mentira. Con el hueco, la línea simplemente termina.
//
// LO SEGUNDO MÁS IMPORTANTE: se dibuja a ESCALA 1:1. Antes el SVG tenía un
// `viewBox` fijo de 960×300 estirado al ancho disponible, y en un monitor ancho
// eso multiplicaba TODO por dos: la gráfica pasaba de 300 a 600 px de alto y
// las etiquetas de los ejes, escritas en unidades del viewBox, salían a 22 px.
// Se comía la pantalla y había que alejar el zoom para ver el resto. Ahora se
// mide el contenedor y se dibuja con esos píxeles: el alto es el que decimos y
// un texto de 11 px mide 11 px en cualquier pantalla.
//
// Los colores y el orden de las fases están en fases.ts.

import { useEffect, useMemo, useState } from "react";
import type { FlujoPorFechaRow } from "@/types/comisiones";
import type { Metrica } from "@/features/flujo-producto/flujo-piezas";
import { COLOR_FASE, ETIQUETA_FASE as ETIQUETA, FASES, type Fase } from "@/features/flujo-producto/fases";

// Alto fijo, en píxeles de pantalla, y de aquí sale también el alto de la caja
// (style={{ height: ALTO }}): si el número viviera además en el CSS, cualquier
// día uno de los dos se quedaría atrás. La gráfica es la pieza principal, pero
// no puede quedarse con el alto de la ventana: debajo hay cinco tarjetas que
// también se miran.
const ALTO = 230;
const MARGEN = { arriba: 14, derecha: 92, abajo: 26, izquierda: 60 };
const TRAZO = 2; // marcas finas, como manda la guía
// Separación mínima entre dos etiquetas de fin de serie y ancho mínimo por
// etiqueta del eje de fechas.
const SEPARACION_ETIQUETA = 14;
const ANCHO_FECHA = 58;

const FORMATO: Record<Metrica, { eje: Intl.NumberFormat; detalle: Intl.NumberFormat }> = {
  importe: {
    eje: new Intl.NumberFormat("es-MX", {
      notation: "compact",
      maximumFractionDigits: 1,
      currency: "MXN",
      style: "currency"
    }),
    detalle: new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
  },
  lineas: {
    eje: new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 }),
    detalle: new Intl.NumberFormat("es-MX")
  },
  cajas: {
    eje: new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 }),
    detalle: new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 })
  }
};

function valorDe(fila: FlujoPorFechaRow, metrica: Metrica): number | null {
  if (metrica === "importe") return fila.monto_total;
  if (metrica === "lineas") return fila.num_lineas;
  return fila.cantidad_cajas_total;
}

function diaCorto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

/** Redondea el techo del eje a algo legible en vez de al máximo exacto. */
function techo(max: number): number {
  if (max <= 0) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / (magnitud / 2)) * (magnitud / 2);
}

/**
 * Ancho real del contenedor, en píxeles. El nodo se guarda en estado (no en un
 * ref) para que el observador se enganche también cuando el contenedor aparece
 * después —al pasar de "sin datos" a "con datos", por ejemplo—.
 */
function useAncho(): [(nodo: HTMLDivElement | null) => void, number] {
  const [nodo, setNodo] = useState<HTMLDivElement | null>(null);
  const [ancho, setAncho] = useState(0);

  useEffect(() => {
    if (!nodo) return;
    const observador = new ResizeObserver((entradas) => {
      setAncho(Math.round(entradas[0].contentRect.width));
    });
    observador.observe(nodo);
    setAncho(Math.round(nodo.getBoundingClientRect().width));
    return () => observador.disconnect();
  }, [nodo]);

  return [setNodo, ancho];
}

export function FlujoChart({ filas, metrica }: { filas: FlujoPorFechaRow[]; metrica: Metrica }) {
  const [medir, ancho] = useAncho();
  const [activo, setActivo] = useState<number | null>(null);
  const { eje: compacto, detalle: completo } = FORMATO[metrica];

  const { fechas, series, maximo } = useMemo(() => {
    const fechasUnicas = Array.from(new Set(filas.map((f) => f.fecha))).sort();
    const indice = new Map(fechasUnicas.map((f, i) => [f, i]));

    const porFase = new Map<string, (number | null)[]>(
      FASES.map((fase) => [fase, fechasUnicas.map(() => null)])
    );
    for (const fila of filas) {
      const valores = porFase.get(fila.fase);
      const i = indice.get(fila.fecha);
      if (!valores || i === undefined) continue;
      const valor = valorDe(fila, metrica);
      // `null` es "no aplica" (las cajas solo existen en facturado) y tiene que
      // seguir siendo hueco, no cero.
      if (valor === null) continue;
      valores[i] = (valores[i] ?? 0) + valor;
    }

    const todos = Array.from(porFase.values()).flat().filter((v): v is number => v !== null);
    return {
      fechas: fechasUnicas,
      series: porFase,
      maximo: techo(todos.length ? Math.max(...todos) : 0)
    };
  }, [filas, metrica]);

  if (!fechas.length) {
    return (
      <div className="flujo-chart-empty">
        <b>Sin movimientos que dibujar</b>
        <span>Prueba con otro rango de fechas.</span>
      </div>
    );
  }

  const anchoUtil = Math.max(120, ancho - MARGEN.izquierda - MARGEN.derecha);
  const altoUtil = ALTO - MARGEN.arriba - MARGEN.abajo;
  const x = (i: number) =>
    MARGEN.izquierda + (fechas.length === 1 ? anchoUtil / 2 : (i * anchoUtil) / (fechas.length - 1));
  const y = (valor: number) => MARGEN.arriba + altoUtil - (valor / maximo) * altoUtil;

  /**
   * Un `path` por fase. Los huecos cortan el trazo con `M` en vez de unir el
   * punto anterior con el siguiente: si no, la línea de "vendido" cruzaría en
   * diagonal las tres semanas sin datos como si hubiera habido ventas.
   */
  function trazo(valores: (number | null)[]): string {
    let d = "";
    let dibujando = false;
    valores.forEach((valor, i) => {
      if (valor === null) {
        dibujando = false;
        return;
      }
      d += `${dibujando ? "L" : "M"}${x(i).toFixed(1)} ${y(valor).toFixed(1)} `;
      dibujando = true;
    });
    return d.trim();
  }

  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((p) => p * maximo);

  // Cuántas fechas caben sin pisarse. Antes se pintaba siempre una de cada
  // ocho más la última, y la última se solapaba con su vecina.
  const cabenFechas = Math.max(2, Math.floor(anchoUtil / ANCHO_FECHA));
  const pasoX = Math.max(1, Math.ceil(fechas.length / cabenFechas));
  const indicesFecha = fechas.map((_, i) => i).filter((i) => i % pasoX === 0);
  const ultimaFecha = fechas.length - 1;
  if (ultimaFecha - (indicesFecha[indicesFecha.length - 1] ?? 0) >= pasoX / 2) {
    indicesFecha.push(ultimaFecha);
  }

  /**
   * Etiqueta al final de cada línea. Es la identidad de la serie sin depender
   * solo del color, pero si dos fases acaban al mismo importe los textos se
   * montan uno sobre otro: se separan lo justo para poder leerlos.
   */
  const etiquetas: { fase: Fase; x: number; y: number }[] = [];
  for (const fase of FASES) {
    const valores = series.get(fase) ?? [];
    const ultimo = valores.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);
    if (ultimo < 0) continue;
    etiquetas.push({ fase, x: x(ultimo) + 8, y: y(valores[ultimo] as number) + 4 });
  }
  etiquetas.sort((a, b) => a.y - b.y);
  for (let i = 1; i < etiquetas.length; i += 1) {
    const separacion = etiquetas[i].y - etiquetas[i - 1].y;
    if (separacion < SEPARACION_ETIQUETA) {
      etiquetas[i].y = etiquetas[i - 1].y + SEPARACION_ETIQUETA;
    }
  }

  function alMover(evento: React.MouseEvent<HTMLDivElement>) {
    const caja = evento.currentTarget.getBoundingClientRect();
    const posicion = evento.clientX - caja.left - MARGEN.izquierda;
    const indice = Math.round((posicion / anchoUtil) * (fechas.length - 1));
    setActivo(Math.min(fechas.length - 1, Math.max(0, indice)));
  }

  // El tooltip se voltea al otro lado cuando el día activo está en el tramo
  // derecho: si no, se sale de la tarjeta.
  const tooltipDerecha = activo !== null && x(activo) > MARGEN.izquierda + anchoUtil * 0.62;

  return (
    <div className="flujo-chart">
      <div className="flujo-chart-legend">
        {FASES.map((fase) => (
          <span key={fase}>
            <i style={{ background: COLOR_FASE[fase] }} aria-hidden="true" />
            {ETIQUETA[fase]}
          </span>
        ))}
      </div>

      {/* El SVG va posicionado en absoluto (ver globals.css): lleva un ancho en
          píxeles, y en flujo normal ese ancho entraba en el cálculo del
          min-content de la rejilla que lo contiene. Resultado: cada medida
          ensanchaba la columna, la columna ensanchaba la medida, y la página
          crecía sin freno hasta varios miles de píxeles. Fuera del flujo no
          aporta tamaño intrínseco y el bucle no existe. */}
      <div
        className="flujo-chart-plot"
        onMouseLeave={() => setActivo(null)}
        onMouseMove={alMover}
        ref={medir}
        style={{ height: ALTO }}
      >
        {/* Hasta que se conoce el ancho no se dibuja: pintar con un ancho
            inventado y corregirlo después es un salto visible. El hueco lo
            reserva el alto fijo de `.flujo-chart-plot`. */}
        {ancho > 0 ? (
          <svg
            aria-label="Importe diario por fase"
            height={ALTO}
            role="img"
            viewBox={`0 0 ${ancho} ${ALTO}`}
            width={ancho}
          >
            {ticksY.map((valor) => (
              <g key={valor}>
                <line
                  className="flujo-chart-grid"
                  x1={MARGEN.izquierda}
                  x2={MARGEN.izquierda + anchoUtil}
                  y1={y(valor)}
                  y2={y(valor)}
                />
                <text className="flujo-chart-axis" x={MARGEN.izquierda - 10} y={y(valor) + 4} textAnchor="end">
                  {compacto.format(valor)}
                </text>
              </g>
            ))}

            {indicesFecha.map((i) => (
              <text className="flujo-chart-axis" key={fechas[i]} textAnchor="middle" x={x(i)} y={ALTO - 8}>
                {diaCorto(fechas[i])}
              </text>
            ))}

            {activo !== null ? (
              <line
                className="flujo-chart-crosshair"
                x1={x(activo)}
                x2={x(activo)}
                y1={MARGEN.arriba}
                y2={ALTO - MARGEN.abajo}
              />
            ) : null}

            {FASES.map((fase) => {
              const valores = series.get(fase) ?? [];
              return (
                <g key={fase}>
                  <path className="flujo-chart-line" d={trazo(valores)} stroke={COLOR_FASE[fase]} strokeWidth={TRAZO} />
                  {activo !== null && valores[activo] !== null && valores[activo] !== undefined ? (
                    <circle
                      className="flujo-chart-dot"
                      cx={x(activo)}
                      cy={y(valores[activo] as number)}
                      fill={COLOR_FASE[fase]}
                      r={4}
                    />
                  ) : null}
                </g>
              );
            })}

            {etiquetas.map((etiqueta) => (
              <text
                className="flujo-chart-label"
                fill={COLOR_FASE[etiqueta.fase]}
                key={etiqueta.fase}
                x={etiqueta.x}
                y={etiqueta.y}
              >
                {ETIQUETA[etiqueta.fase]}
              </text>
            ))}
          </svg>
        ) : null}

        {activo !== null && ancho > 0 ? (
          <div
            className="flujo-chart-tooltip"
            data-lado={tooltipDerecha ? "izquierda" : "derecha"}
            role="status"
            style={{ left: `${x(activo)}px` }}
          >
            <b>{fechas[activo]}</b>
            {FASES.map((fase) => {
              const valor = (series.get(fase) ?? [])[activo];
              return (
                <span key={fase}>
                  <i style={{ background: COLOR_FASE[fase] }} aria-hidden="true" />
                  {ETIQUETA[fase]}
                  <em>{valor === null || valor === undefined ? "sin dato" : completo.format(valor)}</em>
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
