"use client";

// Piezas de animación del manual: aparecer al entrar en pantalla, números que
// cuentan y un anillo de progreso.
//
// TRES REGLAS que se respetan aquí y conviene no romper:
//   1. Nada queda oculto si la animación no llega a ocurrir. El contenido se
//      escribe siempre en el HTML; la animación solo cambia cómo entra. Si no
//      hay IntersectionObserver, se da por visto y punto.
//   2. Quien pide menos movimiento (`prefers-reduced-motion`) recibe el número
//      final de golpe y sin transiciones — no una versión "suave".
//   3. Cada observador se desconecta en cuanto ha hecho su trabajo. Un manual
//      largo tiene veinte de estos y no van a quedarse escuchando el scroll.

import { useEffect, useState, type ReactNode } from "react";

/** ¿Ha pedido el sistema menos movimiento? */
function menosMovimiento(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Devuelve un ref-callback y si el elemento ya ha entrado en pantalla alguna
 * vez. El nodo se guarda en estado, no en un ref, para que el observador se
 * enganche también cuando el elemento aparece más tarde.
 */
export function useEnPantalla<T extends HTMLElement>(): [(nodo: T | null) => void, boolean] {
  const [nodo, setNodo] = useState<T | null>(null);
  const [visto, setVisto] = useState(false);

  useEffect(() => {
    if (visto || !nodo) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisto(true);
      return;
    }
    const observador = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((entrada) => entrada.isIntersecting)) {
          setVisto(true);
          observador.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    observador.observe(nodo);
    return () => observador.disconnect();
  }, [nodo, visto]);

  return [setNodo, visto];
}

/** Envoltura que aparece al entrar en pantalla. `orden` escalona a los hermanos. */
export function Revelar({
  children,
  className,
  orden = 0
}: {
  children: ReactNode;
  className?: string;
  orden?: number;
}) {
  const [medir, visto] = useEnPantalla<HTMLDivElement>();
  return (
    <div
      className={className ? `manual-revelar ${className}` : "manual-revelar"}
      data-visto={visto ? "si" : "no"}
      ref={medir}
      style={{ transitionDelay: `${Math.min(orden, 6) * 80}ms` }}
    >
      {children}
    </div>
  );
}

/**
 * Número que cuenta hasta su valor la primera vez que se ve.
 *
 * El HTML de partida ya lleva el valor final formateado: así el número es
 * correcto antes de que corra un solo fotograma —y en el HTML del servidor—, y
 * la animación es un adorno que se le pone encima, no la fuente del dato.
 */
export function Contador({
  valor,
  formato,
  duracion = 950
}: {
  valor: number;
  formato: (n: number) => string;
  duracion?: number;
}) {
  const [medir, visto] = useEnPantalla<HTMLSpanElement>();
  const [mostrado, setMostrado] = useState<number | null>(null);

  useEffect(() => {
    if (!visto) return;
    if (menosMovimiento()) {
      setMostrado(valor);
      return;
    }
    let animacion = 0;
    let inicio: number | null = null;
    const paso = (ahora: number) => {
      inicio ??= ahora;
      const avance = Math.min(1, (ahora - inicio) / duracion);
      // Desacelera al final: un contador lineal parece un marcador roto.
      setMostrado(valor * (1 - (1 - avance) ** 3));
      if (avance < 1) animacion = requestAnimationFrame(paso);
    };
    animacion = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(animacion);
  }, [visto, valor, duracion]);

  return (
    <span className="manual-contador" ref={medir}>
      {formato(mostrado ?? valor)}
    </span>
  );
}

/** Anillo de progreso: cuántas de N piezas están resueltas. */
export function Anillo({
  hechas,
  total,
  etiqueta
}: {
  hechas: number;
  total: number;
  etiqueta: string;
}) {
  const [medir, visto] = useEnPantalla<HTMLDivElement>();
  const radio = 26;
  const circunferencia = 2 * Math.PI * radio;
  const proporcion = total > 0 ? hechas / total : 0;

  return (
    <div className="manual-anillo" data-visto={visto ? "si" : "no"} ref={medir}>
      <div className="manual-anillo-caja">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="manual-anillo-pista" cx="32" cy="32" r={radio} />
          <circle
            className="manual-anillo-arco"
            cx="32"
            cy="32"
            r={radio}
            strokeDasharray={circunferencia}
            // Cerrado del todo hasta que entra en pantalla: entonces se abre
            // hasta su proporción. La transición está en el CSS.
            strokeDashoffset={visto ? circunferencia * (1 - proporcion) : circunferencia}
            transform="rotate(-90 32 32)"
          />
        </svg>
        <b>
          {hechas}
          <small>/{total}</small>
        </b>
      </div>
      <span>{etiqueta}</span>
    </div>
  );
}
