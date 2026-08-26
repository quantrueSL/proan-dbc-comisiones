"use client";

// Barras VERTICALES para la pantalla de comisiones.
//
// POR QUÉ EXISTE, si ya hay `RankedBars` en flujo-piezas: porque aquello no es
// una gráfica, es una lista. Rótulo a la izquierda, barra en medio, cifra
// alineada a la derecha en columna — se lee como una tabla con una barra
// dentro. Para una serie de meses eso es lo peor de los dos mundos: la
// tendencia no se ve (el orden cronológico pelea con la costumbre de leer
// listas como rankings) y encima gasta una fila por mes.
//
// SVG a mano y sin librería, igual que `flujo-chart`: no hay ninguna en las
// dependencias y meter una por esto serían cientos de KB en el navegador.
//
// SE DIBUJA A ESCALA 1:1, no con un `viewBox` estirado. Con viewBox fijo, en un
// monitor ancho se multiplica todo —incluido el texto de los ejes— y la tarjeta
// se come la pantalla. Es el fallo que ya se arregló en `flujo-chart`.
//
// EL EJE EMPIEZA EN CERO y no se recorta. Una barra cortada por abajo exagera
// las diferencias entre meses, y esas diferencias son justo lo que alguien va a
// mirar para decidir una provisión.

import { useEffect, useMemo, useState } from "react";

// Dos alturas de caja, según cómo vayan los rótulos. El girado es más alto a
// propósito: los nombres de CEDIS necesitan separarse del eje para leerse, y
// bajarlos dentro de la misma caja habría comido esos píxeles al área de las
// barras. Los 28 px de más salen del hueco que sobraba abajo en esa tarjeta.
//
// LAS TRES CONSTANTES DEL RÓTULO GIRADO VAN JUNTAS. Subir la separación sin
// subir `ALTO_GIRADO` y `ABAJO_GIRADO` a la vez no da ningún error: solo recorta
// los nombres por abajo, porque el texto girado DESCIENDE desde su anclaje. La
// cuenta que tiene que seguir cumpliéndose es
// `ALTO_GIRADO - (ALTO_GIRADO - ABAJO_GIRADO + SEPARACION) >= 40`, o sea que
// queden 40 px por debajo del anclaje; hay un test que lo vigila.
const ALTO = 172;
const ALTO_GIRADO = 200;
// `abajo` depende de la inclinación del rótulo: girado necesita el triple de
// alto, y reservarlo siempre dejaría un hueco muerto bajo la serie de meses.
const MARGEN = { arriba: 18, derecha: 6, izquierda: 54, abajo: 22 };
const ABAJO_GIRADO = 82;
// Cuánto se separa el rótulo de la línea del cero. Girado necesita más aire:
// pegado al eje, el nombre se mezcla con el pie de las barras.
const SEPARACION_ROTULO = 14;
const SEPARACION_ROTULO_GIRADO = 34;
// Suelo del área de dibujo: en servidor el contenedor mide 0, y sin esto no se
// emitiría ni una barra ni un rótulo — el HTML de partida saldría vacío.
const ANCHO_UTIL_MIN = 120;
const HUECO_REL = 0.34;
const ANCHO_BARRA_MAX = 54;
// Por debajo de este paso la cifra de encima de la barra se pisa con la vecina.
const PASO_MIN_PARA_CIFRA = 40;
const GIRO = -32;

const completo = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0
});

/**
 * Formato abreviado PROPIO, y no `Intl` con `notation: "compact"`.
 *
 * Node y el navegador no traen la misma versión de ICU, y esa notación NO
 * coincide entre versiones: el Node del contenedor de desarrollo escribe el
 * cero como "$0.0" y Chrome como "$0". Eso es texto distinto en servidor y en
 * cliente, o sea un fallo de hidratación — y cuando React no puede hidratar
 * tira el HTML del servidor y vuelve a renderizar la rama entera. No es
 * cosmético: se llevó por delante media pantalla.
 *
 * Y no se caza en local ni en CI, porque ahí el Node que renderiza y el que
 * corre los tests son el mismo: hace falta que las dos ICU discrepen. Por eso
 * el eje no pasa por `Intl`. El `toString()` de un número no depende del locale
 * ni de ICU, así que imprime igual en los dos lados — y en es-MX el separador
 * decimal es el punto, que es justo lo que sale.
 */
export function abreviar(valor: number): string {
  const abs = Math.abs(valor);
  const [divisor, sufijo] =
    abs >= 1_000_000 ? [1_000_000, " M"] : abs >= 1_000 ? [1_000, " k"] : [1, ""];
  // Un decimal como máximo, y sin el ".0" colgando.
  return `$${Math.round((valor / divisor) * 10) / 10}${sufijo}`;
}

export type BarraVertical = {
  /** Lo que se manda al pulsar, y también la CLAVE de la barra. `null` = grupo
   *  sin asignar: no es pulsable y no hay más de uno por gráfica. */
  valor: string | null;
  /** Lo que se dibuja bajo la barra. Puede venir recortado. */
  etiqueta: string;
  cantidad: number;
  /** El nombre entero, cuando `etiqueta` va recortada. Para el tooltip. */
  nombre?: string;
  /** Solo para el grupo sin asignar, que no es una categoría más. */
  color?: string;
};

/** Techo del eje redondeado hacia arriba a 1, 2, 2,5 o 5 × 10^n, para que las
 *  líneas de referencia caigan en cifras que alguien pueda leer. */
export function techoBonito(maximo: number): number {
  if (maximo <= 0) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(maximo));
  for (const paso of [1, 2, 2.5, 5, 10]) {
    if (magnitud * paso >= maximo) return magnitud * paso;
  }
  return magnitud * 10;
}

/** Ancho real del contenedor, en píxeles. El nodo va en estado y no en un ref
 *  para que el observador se enganche también cuando el contenedor aparece más
 *  tarde (al pasar de "sin datos" a "con datos", por ejemplo). */
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

export function BarrasVerticales({
  datos,
  color,
  onSelect,
  seleccion = null,
  rotulosGirados = false,
  titulo,
  vacio = "Sin datos en el periodo"
}: {
  datos: BarraVertical[];
  color: string;
  /** Sin esto las barras no son pulsables, y tampoco lo aparentan. */
  onSelect?: (valor: string) => void;
  seleccion?: string | null;
  /** Para rótulos largos, como los nombres de CEDIS. Los meses van rectos. */
  rotulosGirados?: boolean;
  titulo?: (dato: BarraVertical, activa: boolean) => string;
  vacio?: string;
}) {
  const [medir, ancho] = useAncho();
  const techo = useMemo(() => techoBonito(Math.max(0, ...datos.map((d) => d.cantidad))), [datos]);

  if (!datos.length) {
    return (
      <div className="comisiones-grafica" ref={medir}>
        <p className="dashboard-empty">{vacio}</p>
      </div>
    );
  }

  const altoCaja = rotulosGirados ? ALTO_GIRADO : ALTO;
  const abajo = rotulosGirados ? ABAJO_GIRADO : MARGEN.abajo;
  const separacion = rotulosGirados ? SEPARACION_ROTULO_GIRADO : SEPARACION_ROTULO;
  const anchoUtil = Math.max(ANCHO_UTIL_MIN, ancho - MARGEN.izquierda - MARGEN.derecha);
  const altoUtil = altoCaja - MARGEN.arriba - abajo;
  // Donde se apoyan los rótulos: la línea del cero, más su separación.
  const yRotulo = altoCaja - abajo + separacion;

  const paso = anchoUtil / datos.length;
  const anchoBarra = Math.max(2, Math.min(ANCHO_BARRA_MAX, paso * (1 - HUECO_REL)));
  const centro = (i: number) => MARGEN.izquierda + paso * (i + 0.5);
  const y = (valor: number) => MARGEN.arriba + altoUtil * (1 - valor / techo);
  const cabenCifras = paso >= PASO_MIN_PARA_CIFRA;
  const ticks = [0, 0.5, 1].map((p) => p * techo);

  return (
    <div className="comisiones-grafica" ref={medir}>
      <svg height={altoCaja} role="img" width="100%" aria-label="Comisión en barras">
        {ticks.map((valor) => (
          <g key={valor}>
            <line
              className="comisiones-grafica-linea"
              x1={MARGEN.izquierda}
              x2={MARGEN.izquierda + anchoUtil}
              y1={y(valor)}
              y2={y(valor)}
            />
            <text className="comisiones-grafica-eje" x={MARGEN.izquierda - 7} y={y(valor) + 3.5}>
              {abreviar(valor)}
            </text>
          </g>
        ))}

        {datos.map((dato, indice) => {
          const activa = seleccion !== null && seleccion === dato.valor;
          const pulsable = Boolean(onSelect) && dato.valor !== null;
          const alto = Math.max(1, altoUtil - (y(dato.cantidad) - MARGEN.arriba));
          return (
            <g
              className="comisiones-grafica-barra"
              data-activa={activa ? "si" : undefined}
              data-pulsable={pulsable ? "si" : undefined}
              // Por `valor` y NO por `etiqueta`: el rótulo puede venir recortado
              // y dos nombres largos que empiezan igual colapsan en la misma
              // clave. React con claves repetidas puede OMITIR un hijo, así que
              // el síntoma no es un aviso en la consola, es una barra que falta.
              key={dato.valor ?? "sin-asignar"}
              onClick={() => pulsable && dato.valor && onSelect?.(dato.valor)}
            >
              <title>
                {titulo
                  ? titulo(dato, activa)
                  : `${dato.nombre ?? dato.etiqueta}: ${completo.format(dato.cantidad)}`}
              </title>
              {/* Franja invisible a toda la altura: da sitio al puntero y al
                  tooltip también cuando la barra es muy baja. */}
              <rect
                fill="transparent"
                height={altoUtil + MARGEN.arriba}
                width={paso}
                x={centro(indice) - paso / 2}
                y={0}
              />
              <rect
                fill={dato.color ?? color}
                height={alto}
                rx={3}
                width={anchoBarra}
                x={centro(indice) - anchoBarra / 2}
                y={y(dato.cantidad)}
              />
              {cabenCifras ? (
                <text className="comisiones-grafica-cifra" x={centro(indice)} y={y(dato.cantidad) - 6}>
                  {abreviar(dato.cantidad)}
                </text>
              ) : null}
              {rotulosGirados ? (
                <text
                  className="comisiones-grafica-rotulo"
                  textAnchor="end"
                  transform={`rotate(${GIRO} ${centro(indice)} ${yRotulo})`}
                  x={centro(indice)}
                  y={yRotulo}
                >
                  {dato.etiqueta}
                </text>
              ) : (
                <text className="comisiones-grafica-rotulo" x={centro(indice)} y={yRotulo}>
                  {dato.etiqueta}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
