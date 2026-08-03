export default function AuthenticatedLoading() {
  return (
    <div aria-busy="true" aria-label="Cargando contenido" className="route-skeleton" role="status">
      <span className="sr-only">Cargando contenido…</span>
      <div className="route-skeleton-rail" />
      <div className="route-skeleton-content">
        <div className="route-skeleton-kpis">
          {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
        </div>
        <div className="route-skeleton-heading" />
        <div className="route-skeleton-table">
          {Array.from({ length: 8 }, (_, index) => <span key={index} />)}
        </div>
      </div>
    </div>
  );
}
