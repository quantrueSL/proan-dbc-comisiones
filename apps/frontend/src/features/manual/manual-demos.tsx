"use client";

// Las tres trampas de la pantalla, en forma de juguete.
//
// Están escritas en prosa en el manual, y aun así se leen mal: nadie cree de
// verdad que esconder una fila pueda tirar el total dos tercios hasta que lo ve
// caer. Cada demo tiene un botón que hace la cosa MAL a propósito y enseña qué
// pasaría. Ninguna toca datos reales de la pantalla: son maquetas.
//
// Las cifras de la segunda sí son reales, de la corrida del 13 de agosto de
// 2026 sobre facturado (ver `data/notas/08_cedis_sin_mapear...`), porque el
// tamaño del agujero es justo lo que cuesta creer.

import { useState } from "react";
import { COLOR_FASE } from "@/features/flujo-producto/fases";

const dinero = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0
});

// ─── 1. Un hueco no es un cero ────────────────────────────────────────────

const BIEN = "M20 40 L60 52 L100 34 L140 60 L180 44";
const MAL = `${BIEN} L220 88 L260 88 L300 88`;

export function DemoHueco() {
  const [mal, setMal] = useState(false);

  return (
    <figure className="manual-demo" data-mal={mal ? "si" : "no"}>
      <svg viewBox="0 0 320 110" role="img" aria-label="Una línea con datos hasta la mitad del periodo">
        <line className="manual-demo-suelo" x1="20" x2="300" y1="88" y2="88" />
        {/* Las dos versiones existen siempre y se cruzan por opacidad: un
            `d` no se puede transicionar, dos opacidades sí. */}
        <path className="manual-demo-linea is-mal" d={MAL} stroke={COLOR_FASE.vendido} />
        <path className="manual-demo-linea is-bien" d={BIEN} stroke={COLOR_FASE.vendido} />
        <circle className="manual-demo-punto is-bien" cx="180" cy="44" fill={COLOR_FASE.vendido} r="4" />
        <circle className="manual-demo-punto is-mal" cx="260" cy="88" r="4" />
        <text className="manual-demo-texto is-bien" x="196" y="40">
          aquí se acaba el dato
        </text>
        <text className="manual-demo-texto is-mal" x="230" y="76">
          ¿cero ventas?
        </text>
      </svg>

      <figcaption>
        <button onClick={() => setMal((v) => !v)} type="button">
          {mal ? "Volver a dibujarlo bien" : "Dibujarlo como un cero"}
        </button>
        <span>
          {mal
            ? "Así la línea diría que esos días no se vendió nada. Y sí se vendió: lo que falta es el dato."
            : "La línea termina donde termina el dato. El hueco es el mensaje."}
        </span>
      </figcaption>
    </figure>
  );
}

// ─── 2. Esconder «Sin asignar» ────────────────────────────────────────────

// Exportadas para que un test pueda comprobar que los tramos suman el total y
// que el hueco sigue siendo "dos tercios", que es lo que dice el texto de al
// lado. Si algún día baja, hay que reescribir la frase.
export const CON_CEDIS = 690238875;
export const SIN_CEDIS = 1297057383;
export const TOTAL = CON_CEDIS + SIN_CEDIS;
export const PORCENTAJE_SIN = Math.round((SIN_CEDIS / TOTAL) * 100);

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
          style={{ flexBasis: escondido ? "0%" : `${PORCENTAJE_SIN}%` }}
          title="Sin CEDIS asignado"
        />
      </div>

      <ul className="manual-demo-leyenda">
        <li>
          <i style={{ background: COLOR_FASE.facturado }} aria-hidden="true" />
          Con CEDIS · {dinero.format(CON_CEDIS)} · 1.688.599 líneas · <b>$409 por línea</b>
        </li>
        <li data-apagado={escondido ? "si" : "no"}>
          <i aria-hidden="true" />
          Sin asignar · {dinero.format(SIN_CEDIS)} · 127.720 líneas · <b>$10.155 por línea</b>
        </li>
      </ul>

      <figcaption>
        <button onClick={() => setEscondido((v) => !v)} type="button">
          {escondido ? "Volver a enseñarlo" : "Esconder «Sin asignar»"}
        </button>
        <span>
          {escondido
            ? "El total ya no cuadra con nada y nadie sabría por qué. Por eso la fila se enseña, aunque estorbe."
            : "Son pocas líneas y muy gordas: veinticinco veces la línea normal. Facturado, corrida del 13 de agosto de 2026."}
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
