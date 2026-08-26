"use client";

// Índice lateral con dos cosas vivas: marca el apartado que se está leyendo y
// lleva una barra de avance.
//
// El scroll de esta app NO es el de la ventana, es el de `.proan-content-scroll`
// (la shell ocupa el alto de la pantalla y el contenido va dentro). Eso obliga a
// dos detalles:
//   · El observador se deja con `root` por defecto: aunque el scroll sea de un
//     contenedor interno, lo que se sale de ese contenedor se sale también de la
//     ventana, así que el cálculo vale igual y no hay que localizar al padre.
//   · El evento `scroll` NO burbujea, así que se escucha en `document` en fase
//     de captura: así llega el de cualquier contenedor interno.

import { useEffect, useState } from "react";
import { SECCIONES } from "@/features/manual/manual-secciones";

export function ManualIndice() {
  const [activa, setActiva] = useState(SECCIONES[0].id);
  const [avance, setAvance] = useState(0);

  // Apartado que se está leyendo: el más alto de los que asoman por la banda
  // superior de la pantalla.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const nodos = SECCIONES.map(({ id }) => document.getElementById(id)).filter(
      (nodo): nodo is HTMLElement => nodo !== null
    );
    if (!nodos.length) return;

    const observador = new IntersectionObserver(
      (entradas) => {
        const visibles = entradas
          .filter((entrada) => entrada.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visibles[0]) setActiva(visibles[0].target.id);
      },
      { rootMargin: "-12% 0px -72% 0px" }
    );
    nodos.forEach((nodo) => observador.observe(nodo));
    return () => observador.disconnect();
  }, []);

  // Barra de avance. Se mide contra el contenido del manual, no contra el
  // documento: el resto de la página (barra superior, cabecera) no cuenta.
  useEffect(() => {
    const contenido = document.getElementById("manual-contenido");
    if (!contenido) return;

    const calcular = () => {
      const caja = contenido.getBoundingClientRect();
      const recorrido = caja.height - window.innerHeight;
      if (recorrido <= 0) {
        setAvance(1);
        return;
      }
      setAvance(Math.min(1, Math.max(0, -caja.top / recorrido)));
    };

    calcular();
    document.addEventListener("scroll", calcular, { capture: true, passive: true });
    window.addEventListener("resize", calcular);
    return () => {
      document.removeEventListener("scroll", calcular, { capture: true });
      window.removeEventListener("resize", calcular);
    };
  }, []);

  /** El salto lo hace el navegador, pero suave y sin dejar el `#` en la URL. */
  function irA(evento: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const destino = document.getElementById(id);
    if (!destino) return; // sin destino, que actúe el ancla de siempre
    evento.preventDefault();
    destino.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiva(id);
  }

  return (
    <nav aria-label="Apartados del manual" className="manual-indice">
      <div className="manual-indice-caja">
        <b>En esta página</b>
        <div className="manual-indice-avance" aria-hidden="true">
          <span style={{ transform: `scaleX(${avance})` }} />
        </div>
        <ol>
          {SECCIONES.map((seccion) => (
            <li key={seccion.id}>
              <a
                aria-current={activa === seccion.id ? "true" : undefined}
                href={`#${seccion.id}`}
                onClick={(evento) => irA(evento, seccion.id)}
              >
                {seccion.titulo}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
