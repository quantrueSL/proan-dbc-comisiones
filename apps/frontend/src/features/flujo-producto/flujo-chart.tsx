"use client";

// Serie de vendido / facturado / cobrado en BARRAS AGRUPADAS: tres barras
// delgadas por grupo, en el orden y con los colores de fases.ts.
//
// SVG a mano y sin librería de gráficas: no hay ninguna en las dependencias y
// meter uno de los paquetes habituales por esto serían cientos de KB en el
// navegador para algo que cabe en un fichero.
//
// EL GRANO NO ES SIEMPRE EL DÍA. Tres barras necesitan unos 13 px de sitio, así
// que ocho meses por día en un portátil darían barras de menos de un píxel: una
// mancha. Cuando el día no cabe se agrupa por semana, y si tampoco cabe, por
// mes — y la leyenda lo dice ("agrupado por semana"), porque una barra semanal
// leída como diaria es un error de un factor siete. Quién elige el grano y cómo
// se agrupa está en flujo-serie.ts, que sí se puede testear; aquí solo quedan
// los píxeles.
//
// UN GRUPO SIN DATO NO DIBUJA BARRA, nunca una barra a cero. Cada fase tiene su
// propia fecha de corte y no tienen por qué coincidir: "vendido" sale de
// `sap_VBAP`, cuya carga se ha quedado atrás más de una vez (ver
// data/notas/hallazgos.md; el retraso ha ido de un mes a un día en la misma
// semana, así que aquí no se escribe ningún número de días: la fecha de corte
// de verdad la da `cobertura`). En pantalla eso son grupos con dos barras en
// vez de tres al final de la serie; quien explica por qué es el rótulo de
// cobertura, no la gráfica. Y al agrupar por semana o mes, el grupo donde cae el
// corte sale MÁS BAJO, no vacío: mezcla días con dato y días sin dato. Es el
// precio de agrupar, y por eso el grano va escrito en la leyenda.
//
// SE DIBUJA A ESCALA 1:1. Antes el SVG tenía un `viewBox` fijo de 960×300
// estirado al ancho disponible, y en un monitor ancho eso multiplicaba TODO por
// dos: la gráfica pasaba de 300 a 600 px de alto y las etiquetas de los ejes,
// escritas en unidades del viewBox, salían a 22 px. Se comía la pantalla y había
// que alejar el zoom para ver el resto. Ahora se mide el contenedor y se dibuja
// con esos píxeles: el alto es el que decimos y un texto de 11 px mide 11 px en
// cualquier pantalla.

import { useEffect, useMemo, useState } from "react";
import type { FlujoPorFechaRow } from "@/types/comisiones";
import type { Metrica } from "@/features/flujo-producto/flujo-piezas";
import { COLOR_FASE, ETIQUETA_FASE as ETIQUETA, FASES } from "@/features/flujo-producto/fases";
import {
  agruparSerie,
  AVISO_GRANO,
  etiquetaEje,
  granoQueCabe,
  NOMBRE_GRANO,
  rotuloGrupo
} from "@/features/flujo-producto/flujo-serie";

// Alto fijo, en píxeles de pantalla, y de aquí sale también el alto de la caja
// (style={{ height: ALTO }}): si el número viviera además en el CSS, cualquier
// día uno de los dos se quedaría atrás. La gráfica es la pieza principal, pero
// no puede quedarse con el alto de la ventana: debajo hay cinco tarjetas que
// también se miran.
const ALTO = 230;
// Sin etiquetas de fin de serie (con barras no hay "fin de línea" que rotular),
// el margen derecho ya no reserva 92 px para texto.
const MARGEN = { arriba: 14, derecha: 18, abajo: 26, izquierda: 60 };

// Geometría de las barras. El mínimo es lo que decide el grano: por debajo de
// ANCHO_BARRA_MIN la barra deja de leerse, así que se agrupa. El máximo existe
// para que un rango de cinco días no salga con tres columnas gordas: lo que se
// pidió son barras delgadas.
const ANCHO_BARRA_MIN = 3;
const ANCHO_BARRA_MAX = 12;
// Las tres barras de un grupo van PEGADAS, sin hueco: así el grupo se lee como
// un bloque y lo que se compara de un vistazo es un día contra otro. Con un
// píxel de aire entre ellas, el ojo comparaba las tres barras entre sí y los
// días se desdibujaban. El único hueco es el que separa un día del siguiente.
const HUECO_BARRAS = 0;
// La separación entre días es una PROPORCIÓN del paso, no un número fijo de
// píxeles: si fuera fija, en una pantalla ancha los bloques engordarían y el
// aire entre ellos seguiría siendo el mismo, que es justo lo que hace que los
// días se peguen visualmente. Así la relación bloque/aire se mantiene a
// cualquier ancho. El mínimo en píxeles es para que en el límite —cuando el
// grano está a punto de saltar a semanas— siga habiendo raya de separación.
const HUECO_GRUPOS_REL = 0.3;
const HUECO_GRUPOS_MIN = 3;
// Paso mínimo para que las tres barras sigan midiendo ANCHO_BARRA_MIN con su
// proporción de aire descontada. Por debajo de esto se agrupa por semana.
const PASO_MIN = Math.ceil(
  (FASES.length * ANCHO_BARRA_MIN + (FASES.length - 1) * HUECO_BARRAS) / (1 - HUECO_GRUPOS_REL)
);
// Ancho mínimo por etiqueta del eje de fechas.
const ANCHO_ETIQUETA = 58;

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

  const anchoUtil = Math.max(120, ancho - MARGEN.izquierda - MARGEN.derecha);

  // El grano depende del ancho, así que el ancho entra en las dependencias: al
  // estrechar la ventana la gráfica puede pasar de días a semanas.
  const { claves, series, grano, techoEje, pisoEje } = useMemo(() => {
    const fechas = Array.from(new Set(filas.map((f) => f.fecha)));
    const granoElegido = granoQueCabe(fechas, anchoUtil, PASO_MIN);
    return agruparSerie(filas, (fila) => valorDe(fila, metrica), granoElegido);
  }, [filas, metrica, anchoUtil]);

  if (!claves.length) {
    return (
      <div className="flujo-chart-empty">
        <b>Sin movimientos que dibujar</b>
        <span>Prueba con otro rango de fechas.</span>
      </div>
    );
  }

  const altoUtil = ALTO - MARGEN.arriba - MARGEN.abajo;
  const paso = anchoUtil / claves.length;
  const huecoGrupos = Math.max(HUECO_GRUPOS_MIN, paso * HUECO_GRUPOS_REL);
  const anchoBarra = Math.max(
    1,
    Math.min(ANCHO_BARRA_MAX, (paso - huecoGrupos - (FASES.length - 1) * HUECO_BARRAS) / FASES.length)
  );
  const anchoGrupo = FASES.length * anchoBarra + (FASES.length - 1) * HUECO_BARRAS;

  const centroGrupo = (i: number) => MARGEN.izquierda + paso * (i + 0.5);
  const y = (valor: number) => MARGEN.arriba + (altoUtil * (techoEje - valor)) / (techoEje - pisoEje);
  const yCero = y(0);

  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((p) => pisoEje + p * (techoEje - pisoEje));

  // Cuántas etiquetas de fecha caben sin pisarse. Antes se pintaba siempre una
  // de cada ocho más la última, y la última se solapaba con su vecina.
  const cabenEtiquetas = Math.max(2, Math.floor(anchoUtil / ANCHO_ETIQUETA));
  const pasoEtiqueta = Math.max(1, Math.ceil(claves.length / cabenEtiquetas));
  const indicesEtiqueta = claves.map((_, i) => i).filter((i) => i % pasoEtiqueta === 0);
  const ultima = claves.length - 1;
  if (ultima - (indicesEtiqueta[indicesEtiqueta.length - 1] ?? 0) >= pasoEtiqueta / 2) {
    indicesEtiqueta.push(ultima);
  }
  const variosAnios = new Set(claves.map((clave) => clave.slice(0, 4))).size > 1;

  function alMover(evento: React.MouseEvent<HTMLDivElement>) {
    const caja = evento.currentTarget.getBoundingClientRect();
    const posicion = evento.clientX - caja.left - MARGEN.izquierda;
    const indice = Math.floor(posicion / paso);
    setActivo(Math.min(claves.length - 1, Math.max(0, indice)));
  }

  // El tooltip se voltea al otro lado cuando el grupo activo está en el tramo
  // derecho: si no, se sale de la tarjeta.
  const tooltipDerecha = activo !== null && centroGrupo(activo) > MARGEN.izquierda + anchoUtil * 0.62;

  return (
    <div className="flujo-chart">
      <div className="flujo-chart-legend">
        {FASES.map((fase) => (
          <span key={fase}>
            <i style={{ background: COLOR_FASE[fase] }} aria-hidden="true" />
            {ETIQUETA[fase]}
          </span>
        ))}
        {/* El grano va en la leyenda, no en un comentario del código: tres
            barras por semana se leen como tres barras por día si nadie lo dice. */}
        {AVISO_GRANO[grano] ? <span className="flujo-chart-grano">{AVISO_GRANO[grano]}</span> : null}
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
            aria-label={`Serie ${NOMBRE_GRANO[grano]} por fase`}
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

            {/* La banda del grupo apuntado va DEBAJO de las barras. */}
            {activo !== null ? (
              <rect
                className="flujo-chart-banda"
                height={altoUtil}
                width={paso}
                x={MARGEN.izquierda + paso * activo}
                y={MARGEN.arriba}
              />
            ) : null}

            {/* Línea del cero, solo cuando hay valores negativos: si el suelo
                del eje ya es cero, esa línea la dibuja la propia rejilla. */}
            {pisoEje < 0 ? (
              <line
                className="flujo-chart-cero"
                x1={MARGEN.izquierda}
                x2={MARGEN.izquierda + anchoUtil}
                y1={yCero}
                y2={yCero}
              />
            ) : null}

            {claves.map((clave, i) =>
              FASES.map((fase, k) => {
                const valor = (series.get(fase) ?? [])[i];
                // Sin dato no se dibuja nada. Una barra a cero diría que esa
                // fase movió cero ese día, que es otra cosa distinta.
                if (valor === null || valor === undefined) return null;
                const desde = Math.min(y(valor), yCero);
                const hasta = Math.max(y(valor), yCero);
                return (
                  <rect
                    className="flujo-chart-barra"
                    fill={COLOR_FASE[fase]}
                    height={valor === 0 ? 0 : Math.max(1, hasta - desde)}
                    key={`${clave}-${fase}`}
                    width={anchoBarra}
                    x={centroGrupo(i) - anchoGrupo / 2 + k * (anchoBarra + HUECO_BARRAS)}
                    y={desde}
                  />
                );
              })
            )}

            {indicesEtiqueta.map((i) => (
              <text className="flujo-chart-axis" key={claves[i]} textAnchor="middle" x={centroGrupo(i)} y={ALTO - 8}>
                {etiquetaEje(claves[i], grano, variosAnios)}
              </text>
            ))}
          </svg>
        ) : null}

        {activo !== null && ancho > 0 ? (
          <div
            className="flujo-chart-tooltip"
            data-lado={tooltipDerecha ? "izquierda" : "derecha"}
            role="status"
            style={{ left: `${centroGrupo(activo)}px` }}
          >
            <b>{rotuloGrupo(claves[activo], grano)}</b>
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
