import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getCortesMes } from "@/lib/comisionesbi";
import { CortesWorkspace } from "@/features/conciliacion-cortes/cortes-workspace";
import { mesPorDefecto, mesesDisponibles } from "@/features/conciliacion-cortes/cortes-logica";
import { EMPTY_CATALOG, type ComisionesCatalog, type CortesMesResponse } from "@/types/comisiones";

// Fecha de México, no la del servidor (mismo criterio que la pantalla de Conciliación).
function fechaMexicoISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
}

// Pestaña de pruebas de conciliación por cortes: convive con /conciliacion.
export default async function ConciliacionCortesPage() {
  requireSession();

  const hoy = fechaMexicoISO();
  const mes = mesPorDefecto(hoy);
  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let response: CortesMesResponse | null = null;
  let error: string | null = null;

  const [catalogo, cortes] = await Promise.allSettled([getComisionesCatalog(), getCortesMes({ mes })]);

  if (catalogo.status === "fulfilled") {
    catalog = catalogo.value;
  } else {
    error = catalogo.reason instanceof Error ? catalogo.reason.message : "No se pudo cargar el catálogo de división.";
  }
  if (cortes.status === "fulfilled") {
    response = cortes.value;
  } else {
    error = error ?? (cortes.reason instanceof Error ? cortes.reason.message : "No se pudo cargar la conciliación por cortes.");
  }

  const meses = mesesDisponibles(response?.cobertura?.desde ?? "2026-01-01", hoy);

  return (
    <CortesWorkspace
      initialCatalog={catalog}
      initialError={error}
      initialResponse={response}
      mesInicial={mes}
      meses={meses}
    />
  );
}
