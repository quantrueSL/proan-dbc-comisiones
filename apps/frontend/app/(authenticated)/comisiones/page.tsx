import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getComisionesReport } from "@/lib/comisionesbi";
import { rangoPorDefectoCompartido } from "@/lib/rango-por-defecto";
import { ComisionesWorkspace } from "@/features/comisiones/comisiones-workspace";
import { EMPTY_CATALOG, type ComisionesCatalog, type ReportResponse } from "@/types/comisiones";

export default async function ComisionesPage() {
  requireSession();

  const { desde: DESDE, hasta: hoy } = rangoPorDefectoCompartido();

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
