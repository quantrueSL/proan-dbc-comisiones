"use client";

// Las tres trampas de la pantalla, en forma de juguete.
//
// Están escritas en prosa en el manual, y aun así se leen mal: nadie cree que
// esconder una fila descuadre el total hasta que lo ve caer. Cada demo tiene un
// botón que hace la cosa MAL a propósito y enseña qué pasaría. Ninguna toca
// datos reales de la pantalla: son maquetas.
//
// Las cifras de la segunda sí son reales, de la corrida del 25 de agosto de
// 2026 sobre facturado (ver `data/notas/tablas_del_cliente.md`).

import { useState } from "react";
import { COLOR_FASE } from "@/features/flujo-producto/fases";

const dinero = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0
});

// ─── 1. Una barra que falta no es un cero ─────────────────────────────────

// Seis días con sus tres barras, como la gráfica de verdad. En los dos últimos
// no hay dato de vendido: la versión buena no dibuja nada y la mala dibuja una
// barra a ras del suelo, que es la mentira que se quiere enseñar.
const SUELO = 88;
const PASO = 46;
const ANCHO = 8;
const DIAS: { vendido: number | null; facturado: number; cobrado: number }[] = [
  { vendido: 44, facturado: 38, cobrado: 30 },
  { vendido: 50, facturado: 42, cobrado: 34 },
  { vendido: 40, facturado: 46, cobrado: 28 },
  { vendido: 52, facturado: 40, cobrado: 36 },
  { vendido: null, facturado: 44, cobrado: 32 },
  { vendido: null, facturado: 48, cobrado: 30 }
];

export function DemoHueco() {
  const [mal, setMal] = useState(false);

  return (
    <figure className="manual-demo" data-mal={mal ? "si" : "no"}>
      <svg
        viewBox="0 0 320 110"
        role="img"
        aria-label="Seis días con tres barras cada uno; en los dos últimos falta la barra de vendido"
      >
        <line className="manual-demo-suelo" x1="16" x2="304" y1={SUELO} y2={SUELO} />
        {DIAS.map((dia, i) => {
          const x = 20 + PASO * i;
          return (
            <g key={i}>
              {/* Las dos versiones del día sin dato existen siempre y se cruzan
                  por opacidad, igual que en las otras demos. */}
              {dia.vendido === null ? (
                <rect
                  className="manual-demo-barra is-mal"
                  height="3"
                  width={ANCHO}
                  x={x}
                  y={SUELO - 3}
                />
              ) : (
                <rect
                  className="manual-demo-barra"
                  fill={COLOR_FASE.vendido}
                  height={SUELO - dia.vendido}
                  width={ANCHO}
                  x={x}
                  y={dia.vendido}
                />
              )}
              <rect
                className="manual-demo-barra"
                fill={COLOR_FASE.facturado}
                height={SUELO - dia.facturado}
                width={ANCHO}
                x={x + ANCHO}
                y={dia.facturado}
              />
              <rect
                className="manual-demo-barra"
                fill={COLOR_FASE.cobrado}
                height={SUELO - dia.cobrado}
                width={ANCHO}
                x={x + ANCHO * 2}
                y={dia.cobrado}
              />
            </g>
          );
        })}
        <text className="manual-demo-texto is-bien" x="212" y="26">
          aquí se acaba el dato
        </text>
        <text className="manual-demo-texto is-mal" x="212" y="26">
          ¿cero ventas?
        </text>
      </svg>

      <figcaption>
        <button onClick={() => setMal((v) => !v)} type="button">
          {mal ? "Volver a dibujarlo bien" : "Dibujarlo como un cero"}
        </button>
        <span>
          {mal
            ? "Esa barrita pegada al suelo diría que esos días no se vendió nada. Y sí se vendió: lo que falta es el dato."
            : "Donde no hay dato no hay barra. La ausencia es el mensaje."}
        </span>
      </figcaption>
    </figure>
  );
}

// ─── 2. Esconder «Sin asignar» ────────────────────────────────────────────

// Exportadas para que un test pueda comprobar que los tramos suman el total y
// que el porcentaje del hueco sigue siendo el que dice el texto de al lado.
// Ha bajado cuatro veces: 65% → 61% con el fallback por oficina → 1,2% cuando
// el cliente aclaró que dos tercios de aquello no eran un hueco (eran
// divisiones que no opera y almacenes centrales que, correctamente, no
// pertenecen a ningún CEDIS) → 0,2% al arreglar el cruce por nombre de
// almacén, que por un NULL comparado con cadena vacía no se ejecutaba nunca.
// Si vuelve a moverse se reescribe la frase; la demo no se queda mintiendo al
// lado del texto.
export const CON_CEDIS = 731201638;
export const SIN_CEDIS = 1331768;
export const TOTAL = CON_CEDIS + SIN_CEDIS;
// Con un decimal: redondear a entero daría 0% y la demo se quedaría sin tramo.
export const PORCENTAJE_SIN = Math.round((SIN_CEDIS / TOTAL) * 1000) / 10;

export function DemoSinAsignar() {
  const [escondido, setEscondido] = useState(false);

  return (
    <figure className="manual-demo manual-demo-barra" data-escondido={escondido ? "si" : "no"}>
      <div className="manual-demo-total">
        <span>Total facturado que enseñaría la pantalla</span>
        <strong key={escondido ? "menos" : "todo"}>
          {dinero.format(escondido ? CON_CEDIS : TOTAL)}
        </strong>
        {escondido ? <em>−{PORCENTAJE_SIN}% sin tocar ningún filtro</em> : null}
      </div>

      <div className="manual-demo-pista">
        <span
          className="manual-demo-tramo"
          style={{ background: COLOR_FASE.facturado, flexBasis: `${100 - PORCENTAJE_SIN}%` }}
          title="Con CEDIS asignado"
        />
        <span
          className="manual-demo-tramo is-sin"
          // A escala real el tramo mide 0,2% y no se vería. Se le da un mínimo
          // en píxeles para que exista en pantalla; el número de al lado es el
          // de verdad y manda sobre lo que se ve.
          style={{
            flexBasis: escondido ? "0%" : `${PORCENTAJE_SIN}%`,
            minWidth: escondido ? 0 : 6
          }}
          title="Sin CEDIS asignado"
        />
      </div>

      <ul className="manual-demo-leyenda">
        <li>
          <i style={{ background: COLOR_FASE.facturado }} aria-hidden="true" />
          Con CEDIS · {dinero.format(CON_CEDIS)} · 1.750.457 líneas · <b>$418 por línea</b>
        </li>
        <li data-apagado={escondido ? "si" : "no"}>
          <i aria-hidden="true" />
          Sin asignar · {dinero.format(SIN_CEDIS)} · 5.485 líneas · <b>$243 por línea</b>
        </li>
      </ul>

      <figcaption>
        <button onClick={() => setEscondido((v) => !v)} type="button">
          {escondido ? "Volver a enseñarlo" : "Esconder «Sin asignar»"}
        </button>
        <span>
          {escondido
            ? "El total ya no cuadra con nada y nadie sabría por qué. Por eso la fila se enseña, aunque estorbe."
            : "El tramo se dibuja con un mínimo para que se vea: a escala real es el 0,2%. Facturado, corrida del 25 de agosto de 2026."}
        </span>
      </figcaption>
    </figure>
  );
}

// ─── 3. Sumar unidades distintas ──────────────────────────────────────────

const MEZCLA = [
  { cantidad: 3, unidad: "CS", nombre: "cajas" },
  { cantidad: 2, unidad: "PZA", nombre: "piezas" },
  { cantidad: 1, unidad: "KG", nombre: "kilos" }
];

export function DemoUnidades() {
  const [sumado, setSumado] = useState(false);
  const total = MEZCLA.reduce((suma, m) => suma + m.cantidad, 0);

  return (
    <figure className="manual-demo manual-demo-unidades" data-sumado={sumado ? "si" : "no"}>
      <div className="manual-demo-mezcla">
        {MEZCLA.map((m, i) => (
          <span className="manual-demo-chip" key={m.unidad}>
            <b>{m.cantidad}</b> {m.unidad}
            <small>{m.nombre}</small>
            {i < MEZCLA.length - 1 ? <i aria-hidden="true">+</i> : null}
          </span>
        ))}
        <i className="manual-demo-igual" aria-hidden="true">
          =
        </i>
        <span className="manual-demo-resultado">{sumado ? `${total} ¿qué?` : "?"}</span>
      </div>

      <figcaption>
        <button onClick={() => setSumado((v) => !v)} type="button">
          {sumado ? "Deshacer la suma" : "Sumarlo todo"}
        </button>
        <span>
          {sumado
            ? "Seis de nada. Un kilo de huevo y una caja de botana no se suman, así que la pantalla no ofrece nunca un total de cantidad."
            : "Las cantidades llegan en cajas, piezas, paquetes, sacos y kilos."}
        </span>
      </figcaption>
    </figure>
  );
}
