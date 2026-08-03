import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getComisionesCatalog, getComisionesReport } from "@/lib/comisionesbi";
import { ComisionesWorkspace } from "@/features/comisiones/comisiones-workspace";
import { EMPTY_CATALOG, type ComisionesCatalog, type ReportResponse } from "@/types/comisiones";

export default async function ComisionesPage() {
  requireSession();

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let report: ReportResponse | null = null;
  let blockedMessage: string | null = null;
  let error: string | null = null;

  try {
    catalog = await getComisionesCatalog();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "No se pudo cargar el catálogo de división/CEDIS.";
  }

  const now = new Date();
  const defaultEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  try {
    report = await getComisionesReport({ division: null, cedis: null, start_period: defaultEnd, end_period: defaultEnd });
  } catch (cause) {
    if (cause instanceof BackendNotReadyError) {
      blockedMessage = cause.message;
    } else {
      error = error ?? (cause instanceof Error ? cause.message : "No se pudo generar el reporte de comisión.");
    }
  }

  return (
    <ComisionesWorkspace
      initialBlockedMessage={blockedMessage}
      initialCatalog={catalog}
      initialError={error}
      initialReport={report}
    />
  );
}
