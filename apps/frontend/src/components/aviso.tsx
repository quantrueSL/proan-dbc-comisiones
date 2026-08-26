"use client";

// Avisos sobre los datos: el icono "i" y el modal que abre.
//
// Vivían dentro de la feature de flujo de producto, que fue donde nacieron. Al
// conectarse la pantalla de comisiones hicieron falta también allí, así que
// suben aquí en vez de duplicarse: un aviso de datos tiene que verse y
// comportarse igual en las dos pantallas, y con dos copias eso dura hasta que
// alguien toca una.
//
// Las clases CSS siguen llamándose `flujo-aviso-boton` y `flujo-modal`. El
// nombre ya no describe dónde se usan, pero renombrarlas obligaría a tocar 23
// reglas de la hoja de estilos de una pantalla que funciona, y eso es más
// riesgo que el que quita.

import { useCallback, useEffect, useState, type ReactNode } from "react";

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
