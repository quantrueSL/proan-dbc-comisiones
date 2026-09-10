import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getComisionesReport } from "@/lib/comisionesbi";
import { ComisionesWorkspace } from "@/features/comisiones/comisiones-workspace";
import { EMPTY_CATALOG, type ComisionesCatalog, type ReportResponse } from "@/types/comisiones";

// El rango por defecto es todo 2026, que es lo que hay cargado. Un mes suelto
// —lo que pedía antes— deja la pantalla casi vacía y parece que no calcula.
// Flujo de producto usa el mismo rango a propósito (ver su page.tsx): cambiar
// de pantalla con un periodo distinto en cada una confunde más de lo que ayuda.
const DESDE = "2026-01-01";

export default async function ComisionesPage() {
  requireSession();

  const hoy = new Date().toISOString().slice(0, 10);

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let report: ReportResponse | null = null;
  let error: string | null = null;

  // Las dos en paralelo: son independientes y el sidecar arranca en frío
  // (mismo patrón que flujo-producto/page.tsx). Antes iban en serie y el
  // arranque en frío se pagaba dos veces seguidas en vez de una.
  const [catalogo, informe] = await Promise.allSettled([
    getComisionesCatalog(),
    getComisionesReport({
      division: null,
      cedis: null,
      comisionista_id: null,
      start_date: DESDE,
      end_date: hoy
    })
  ]);

  if (catalogo.status === "fulfilled") {
    catalog = catalogo.value;
  } else {
    error = catalogo.reason instanceof Error ? catalogo.reason.message : "No se pudo cargar el catálogo de división/CEDIS.";
  }

  if (informe.status === "fulfilled") {
    report = informe.value;
  } else {
    // Ya no hay rama de "bloqueado": el módulo calcula. Si falla, es un fallo
    // de verdad y se dice, en vez de caer a una vista previa de ejemplo que
    // disimulaba el problema.
    error = error ?? (informe.reason instanceof Error ? informe.reason.message : "No se pudo generar el informe de comisión.");
  }

  return (
    <ComisionesWorkspace
      initialCatalog={catalog}
      initialError={error}
      initialReport={report}
      rangoInicial={{ desde: DESDE, hasta: hoy }}
    />
  );
}
