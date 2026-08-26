import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getComisionesReport } from "@/lib/comisionesbi";
import { ComisionesWorkspace } from "@/features/comisiones/comisiones-workspace";
import { EMPTY_CATALOG, type ComisionesCatalog, type ReportResponse } from "@/types/comisiones";

// El rango por defecto es todo 2026, que es lo que hay cargado. Un mes suelto
// —lo que pedía antes— deja la pantalla casi vacía y parece que no calcula.
const DESDE = "2026-01-01";

export default async function ComisionesPage() {
  requireSession();

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let report: ReportResponse | null = null;
  let error: string | null = null;

  try {
    catalog = await getComisionesCatalog();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "No se pudo cargar el catálogo de división/CEDIS.";
  }

  const hoy = new Date().toISOString().slice(0, 10);

  try {
    report = await getComisionesReport({
      division: null,
      cedis: null,
      comisionista: null,
      start_date: DESDE,
      end_date: hoy
    });
  } catch (cause) {
    // Ya no hay rama de "bloqueado": el módulo calcula. Si falla, es un fallo
    // de verdad y se dice, en vez de caer a una vista previa de ejemplo que
    // disimulaba el problema.
    error = error ?? (cause instanceof Error ? cause.message : "No se pudo generar el informe de comisión.");
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
