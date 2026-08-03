// Aviso reutilizable para los módulos cuyo motor todavía está bloqueado
// (comisiones_engine.py / conciliacion_engine.py devuelven 501 a propósito,
// en vez de simular datos -- ver README.md, "Bloqueantes"). Se muestra sobre
// una vista previa con datos de ejemplo, para que se pueda validar la UX ya
// mismo sin fingir que los números son reales.
export function ModuloEnConstruccion({ motivo }: { motivo: string }) {
  return (
    <section aria-live="polite" className="hydro-unavailable" role="status">
      <div>
        <b>Módulo en construcción</b>
        <p>{motivo}</p>
      </div>
    </section>
  );
}

export function EtiquetaVistaPrevia() {
  return <span className="hydro-badge is-neutral">Vista previa · datos de ejemplo</span>;
}
