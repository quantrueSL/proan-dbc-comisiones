// Esqueleto de carga. Imita la forma real de la página (título, tres KPIs,
// gráfica, tablas) en vez de un spinner genérico: así el salto al contenido
// real no mueve nada de sitio y la espera se percibe más corta.
//
// La animación se apaga con `prefers-reduced-motion` (ver globals.css).
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Cargando contenido" className="flujo-skeleton" role="status">
      <div className="flujo-skeleton-bloque" data-alto="titulo" />
      <div className="flujo-skeleton-fila">
        <div className="flujo-skeleton-bloque" data-alto="kpi" />
        <div className="flujo-skeleton-bloque" data-alto="kpi" />
        <div className="flujo-skeleton-bloque" data-alto="kpi" />
      </div>
      <div className="flujo-skeleton-bloque" data-alto="grafica" />
      <div className="flujo-skeleton-bloque" data-alto="tabla" />
    </div>
  );
}
