"use client";

// Piezas de la pantalla de flujo: barras rankeadas, selector de métrica y
// modal. Se apoyan en las clases `.dashboard-*` que ya trae la piel de Proan
// (vienen del dashboard de proan-hidrocarburos), así que esto se ve igual que
// la herramienta hermana sin inventar estilos nuevos.

import { useCallback, useEffect, useState, type ReactNode } from "react";

export type Metrica = "importe" | "lineas" | "cajas";

export const METRICAS: { clave: Metrica; etiqueta: string }[] = [
  { clave: "importe", etiqueta: "Importe" },
  { clave: "lineas", etiqueta: "Líneas" },
  { clave: "cajas", etiqueta: "Cajas" }
];

const dinero = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0
});
const numero = new Intl.NumberFormat("es-MX");

export function formatearMetrica(valor: number | null, metrica: Metrica): string {
  if (valor === null) return "no aplica";
  return metrica === "importe" ? dinero.format(valor) : numero.format(Math.round(valor));
}

export function MetricToggle({
  metrica,
  onChange,
  cajasDisponibles
}: {
  metrica: Metrica;
  onChange: (m: Metrica) => void;
  cajasDisponibles: boolean;
}) {
  return (
    <div className="dashboard-metric-toggle" role="group" aria-label="Métrica">
      {METRICAS.map((opcion) => {
        // Las cajas ya vienen en las tres fases, pero el botón sigue pudiendo
        // quedarse sin nada que enseñar según el filtro: ofrecerlo entonces es
        // prometer un dato que no está.
        const inhabilitada = opcion.clave === "cajas" && !cajasDisponibles;
        return (
          <button
            aria-pressed={metrica === opcion.clave}
            className={metrica === opcion.clave ? "is-active" : undefined}
            disabled={inhabilitada}
            key={opcion.clave}
            onClick={() => onChange(opcion.clave)}
            title={inhabilitada ? "El filtro actual no tiene cajas que enseñar" : undefined}
            type="button"
          >
            {opcion.etiqueta}
          </button>
        );
      })}
    </div>
  );
}

export type BarraDato = {
  /** Valor por el que se filtra. `null` = grupo sin asignar, no filtrable. */
  valor: string | null;
  etiqueta: string;
  cantidad: number;
};

/**
 * Barras ordenadas de mayor a menor. Pulsar una filtra toda la pantalla; volver
 * a pulsar la activa quita el filtro.
 *
 * `limite` recorta la lista a las primeras N. Dieciocho CEDIS y catorce
 * divisiones en tarjetas contiguas dejaban la pantalla en columnas de alturas
 * dispares y obligaban a hacer scroll para ver una gráfica que estaba al lado;
 * con el recorte todas las tarjetas miden parecido y la cola se consulta en la
 * tabla completa, que es donde se lee bien.
 */
export function RankedBars({
  datos,
  metrica,
  seleccion,
  onSelect,
  color = "#5f62d0",
  vacio = "Sin datos en el periodo",
  limite,
  alVerTodo
}: {
  datos: BarraDato[];
  metrica: Metrica;
  seleccion: string | null;
  onSelect: (valor: string | null) => void;
  color?: string;
  vacio?: string;
  limite?: number;
  alVerTodo?: () => void;
}) {
  if (!datos.length) {
    return <p className="dashboard-empty">{vacio}</p>;
  }

  const maximo = Math.max(...datos.map((d) => d.cantidad), 1);
  // La escala se calcula sobre TODOS los datos, no sobre los visibles: si no,
  // recortar la lista repintaría las barras y la más larga siempre llegaría al
  // final, dando a entender que el recorte no existe.
  const visibles = limite ? datos.slice(0, limite) : datos;
  const ocultos = datos.length - visibles.length;

  return (
    <div className="flujo-lista">
      <ul className="dashboard-bar-list">
        {visibles.map((dato) => {
          const activa = seleccion !== null && seleccion === dato.valor;
          const filtrable = dato.valor !== null;
          return (
            <li className="dashboard-bar-row" key={dato.etiqueta}>
              <button
                aria-pressed={activa}
                className="flujo-barra"
                data-activa={activa ? "si" : undefined}
                data-filtrable={filtrable ? "si" : "no"}
                disabled={!filtrable}
                onClick={() => onSelect(activa ? null : dato.valor)}
                title={
                  filtrable
                    ? activa
                      ? `Quitar el filtro de ${dato.etiqueta}`
                      : `Filtrar por ${dato.etiqueta}`
                    : "Sin asignar: no pertenece a ningún grupo, no se puede filtrar"
                }
                type="button"
              >
                <span className="dashboard-bar-label">{dato.etiqueta}</span>
                <span className="dashboard-bar-track">
                  <span
                    className="dashboard-bar-fill"
                    style={{
                      width: `${Math.max(1.5, (dato.cantidad / maximo) * 100)}%`,
                      background: filtrable ? color : "#c9761f"
                    }}
                  />
                </span>
                <span className="dashboard-bar-value">{formatearMetrica(dato.cantidad, metrica)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {alVerTodo ? (
        <button className="flujo-lista-pie" onClick={alVerTodo} type="button">
          {ocultos > 0 ? `Ver los ${datos.length} en la tabla (${ocultos} sin mostrar)` : "Ver la tabla completa"}
          <span aria-hidden="true">→</span>
        </button>
      ) : null}
    </div>
  );
}

// ─── Donut ───────────────────────────────────────────────────────────────
// Para dimensiones con pocas categorías. Muchas categorías van en barras: un
// donut de veinte trozos no se lee.

const DONUT_R = 46;
const DONUT_C = 2 * Math.PI * DONUT_R;
const DONUT_CENTRO = 60;

export type SegmentoDato = BarraDato & { color: string };

export function Donut({
  datos,
  metrica,
  seleccion,
  onSelect,
  leyendaTotal
}: {
  datos: SegmentoDato[];
  metrica: Metrica;
  seleccion: string | null;
  onSelect: (valor: string | null) => void;
  leyendaTotal: string;
}) {
  const total = datos.reduce((suma, d) => suma + d.cantidad, 0);

  if (!total) {
    return <p className="dashboard-empty">Sin datos en el periodo</p>;
  }

  let acumulado = 0;
  const arcos = datos.map((dato) => {
    const trozo = (dato.cantidad / total) * DONUT_C;
    // Se descuentan 2px al arco para dejar hueco del color del fondo entre
    // trozos: sin esa separación, dos colores contiguos se leen como uno.
    const arco = { ...dato, dash: Math.max(0, trozo - 2), offset: -acumulado };
    acumulado += trozo;
    return arco;
  });

  return (
    <div className="dashboard-donut-wrap flujo-donut">
      <svg className="dashboard-donut-svg" viewBox="0 0 120 120" role="img" aria-label={leyendaTotal}>
        <circle className="dashboard-donut-track" cx={DONUT_CENTRO} cy={DONUT_CENTRO} r={DONUT_R} />
        <g transform={`rotate(-90 ${DONUT_CENTRO} ${DONUT_CENTRO})`}>
          {arcos.map((arco) => (
            <circle
              aria-label={`${arco.etiqueta}: ${formatearMetrica(arco.cantidad, metrica)}`}
              className={`dashboard-donut-arc flujo-donut-arco${seleccion === arco.valor ? " is-selected" : ""}`}
              cx={DONUT_CENTRO}
              cy={DONUT_CENTRO}
              key={arco.etiqueta}
              onClick={() => arco.valor !== null && onSelect(seleccion === arco.valor ? null : arco.valor)}
              r={DONUT_R}
              stroke={arco.color}
              strokeDasharray={`${arco.dash} ${DONUT_C - arco.dash}`}
              strokeDashoffset={arco.offset}
              style={{ cursor: arco.valor === null ? "default" : "pointer" }}
            />
          ))}
        </g>
        <text className="dashboard-donut-total" x={DONUT_CENTRO} y={DONUT_CENTRO - 2}>
          {datos.length}
        </text>
        <text className="dashboard-donut-caption" x={DONUT_CENTRO} y={DONUT_CENTRO + 13}>
          {leyendaTotal}
        </text>
      </svg>

      {/* La leyenda es la identidad de verdad: el color solo acompaña. */}
      <ul className="dashboard-status-legend">
        {datos.map((dato) => (
          <li key={dato.etiqueta}>
            <button
              aria-pressed={seleccion === dato.valor}
              className={seleccion === dato.valor ? "is-selected" : ""}
              disabled={dato.valor === null}
              onClick={() => onSelect(seleccion === dato.valor ? null : dato.valor)}
              type="button"
            >
              <span className="dashboard-status-dot" style={{ background: dato.color }} aria-hidden="true" />
              {dato.etiqueta} <b>{formatearMetrica(dato.cantidad, metrica)}</b>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Aviso reducido a su símbolo. Ocupaban media pantalla estando siempre ahí; así
 * siguen visibles —parpadean con color propio— pero solo se despliegan si
 * alguien quiere leerlos.
 */
export function AvisoBoton({
  tono,
  titulo,
  children
}: {
  tono: "dato" | "atencion";
  titulo: string;
  children: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const color = tono === "dato" ? "#5f62d0" : "#c9761f";

  return (
    <>
      <button
        aria-label={titulo}
        className="flujo-aviso-boton"
        data-tono={tono}
        onClick={() => setAbierto(true)}
        title={titulo}
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.9" />
          <path d="M12 7.4v5.6" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="1.15" fill={color} />
        </svg>
      </button>

      {abierto ? (
        <Modal onClose={() => setAbierto(false)} subtitulo="Aviso sobre los datos" titulo={titulo}>
          <div className="flujo-aviso-texto">{children}</div>
        </Modal>
      ) : null}
    </>
  );
}

/** Modal para las tablas: la pantalla se queda con las gráficas y el detalle
 *  se pide, en vez de apilar cuatro tablas que nadie mira. */
export function Modal({
  titulo,
  subtitulo,
  onClose,
  children
}: {
  titulo: string;
  subtitulo?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const cerrar = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    function alPulsar(evento: KeyboardEvent) {
      if (evento.key === "Escape") cerrar();
    }
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [cerrar]);

  return (
    <div className="dashboard-modal-backdrop" onClick={cerrar}>
      <section
        aria-modal="true"
        className="dashboard-modal-card flujo-modal"
        onClick={(evento) => evento.stopPropagation()}
        role="dialog"
        aria-label={titulo}
      >
        <header>
          <div>
            {subtitulo ? <span>{subtitulo}</span> : null}
            <h2>{titulo}</h2>
          </div>
          <button aria-label="Cerrar" onClick={cerrar} type="button">
            ×
          </button>
        </header>
        <div className="flujo-modal-cuerpo">{children}</div>
      </section>
    </div>
  );
}
