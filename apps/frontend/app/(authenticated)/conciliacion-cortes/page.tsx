import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getCortesMes } from "@/lib/comisionesbi";
import { CortesWorkspace } from "@/features/conciliacion-cortes/cortes-workspace";
import { finDeVista, mesAnterior, mesPorDefecto, mesesDisponibles, tienePagosConVentana, vistaDeMes } from "@/features/conciliacion-cortes/cortes-logica";
import { EMPTY_CATALOG, type ComisionesCatalog, type CortesMesResponse } from "@/types/comisiones";

// Fecha de México, no la del servidor (mismo criterio que la pantalla de Conciliación).
function fechaMexicoISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
}

// Las semanas que se ven en pantalla para un mes (la primera puede arrancar el mes anterior): igual que al elegirlo en el selector.
function semanasDe(mes: string) {
  const v = vistaDeMes(mes);
  return { desde: v.ini, hasta: finDeVista(v) };
}

// Conciliación por cortes, la forma de conciliar; /conciliacion queda como vista de consulta.
export default async function ConciliacionCortesPage() {
  const sesion = requireSession();

  const hoy = fechaMexicoISO();
  let mes = mesPorDefecto(hoy);
  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let response: CortesMesResponse | null = null;
  let error: string | null = null;

  const [catalogo, cortes] = await Promise.allSettled([getComisionesCatalog(), getCortesMes(semanasDe(mes))]);

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
        const previa = await getCortesMes(semanasDe(anterior));
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
