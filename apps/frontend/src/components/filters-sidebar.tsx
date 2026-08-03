"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

type Props = {
  activeCount?: number;
  children: ReactNode;
  info: ReactNode;
  infoTitle: string;
  onToggle: () => void;
  open: boolean;
  updatedAt?: string | null;
};

export function FiltersSidebar({ activeCount, children, info, infoTitle, onToggle, open, updatedAt }: Props) {
  const [infoOpen, setInfoOpen] = useState(false);
  const titleId = useId();
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!infoOpen) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setInfoOpen(false);
        infoButtonRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [infoOpen]);

  function closeInfo() {
    setInfoOpen(false);
    infoButtonRef.current?.focus();
  }

  return (
    <>
      <aside aria-label="Filtros" className={`filters-sidebar${open ? "" : " is-collapsed"}`}>
        <div className="filters-sidebar-tools">
          <button
            aria-expanded={open}
            aria-label={open ? "Colapsar filtros" : "Expandir filtros"}
            className="filters-sidebar-toggle"
            onClick={onToggle}
            title={open ? "Colapsar filtros" : "Expandir filtros"}
            type="button"
          >
            <span aria-hidden="true" className="filters-sidebar-toggle-arrow" />
          </button>
          <button
            aria-haspopup="dialog"
            aria-label={`Información sobre ${infoTitle}`}
            className="filters-sidebar-info"
            onClick={() => setInfoOpen(true)}
            ref={infoButtonRef}
            title={`Información sobre ${infoTitle}`}
            type="button"
          >
            <span aria-hidden="true">i</span>
          </button>
        </div>
        <div className="filters-sidebar-body">
          <h3 className="filters-sidebar-title">
            Filtros{activeCount ? <span className="hydro-filters-count">{activeCount}</span> : null}
          </h3>
          {updatedAt ? (
            <p className="filters-sidebar-updated">
              Actualizado{" "}
              {new Intl.DateTimeFormat("es-MX", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "America/Mexico_City"
              }).format(new Date(updatedAt))}
            </p>
          ) : null}
          {children}
        </div>
      </aside>

      {infoOpen ? (
        <div className="module-info-backdrop" onClick={closeInfo}>
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className="module-info-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <span>Acerca de este módulo</span>
                <h2 id={titleId}>{infoTitle}</h2>
              </div>
              <button aria-label="Cerrar información" onClick={closeInfo} ref={closeButtonRef} type="button">
                ×
              </button>
            </header>
            <div className="module-info-content">{info}</div>
          </section>
        </div>
      ) : null}
    </>
  );
}
