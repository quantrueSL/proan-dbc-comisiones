import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getCortesMes } from "@/lib/comisionesbi";
import { CortesWorkspace } from "@/features/conciliacion-cortes/cortes-workspace";
import { mesAnterior, mesPorDefecto, mesesDisponibles, tienePagosConVentana } from "@/features/conciliacion-cortes/cortes-logica";
import { EMPTY_CATALOG, type ComisionesCatalog, type CortesMesResponse } from "@/types/comisiones";

// Fecha de México, no la del servidor (mismo criterio que la pantalla de Conciliación).
function fechaMexicoISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
}

// Pestaña de pruebas de conciliación por cortes: convive con /conciliacion.
export default async function ConciliacionCortesPage() {
  const sesion = requireSession();

  const hoy = fechaMexicoISO();
  let mes = mesPorDefecto(hoy);
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
    // Los pagos se hacen los viernes: mientras el mes nuevo no tenga pagos con ventana (solo algún pago suelto), se abre el anterior.
    for (let intento = 0; intento < 2 && response && !tienePagosConVentana(response); intento++) {
      try {
        const anterior = mesAnterior(mes);
        const previa = await getCortesMes({ mes: anterior });
        if (!tienePagosConVentana(previa)) break;
        mes = anterior;
        response = previa;
      } catch {
        break;
      }
    }
  } else {
    error = error ?? (cortes.reason instanceof Error ? cortes.reason.message : "No se pudo cargar la conciliación por cortes.");
  }

  const meses = mesesDisponibles(response?.cobertura?.desde ?? "2026-01-01", hoy);

  return (
    <CortesWorkspace
      initialCatalog={catalog}
      initialError={error}
      initialResponse={response}
      hoy={hoy}
      mesInicial={mes}
      meses={meses}
      puedeEditar={sesion.role === "admin"}
    />
  );
}
