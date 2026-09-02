import { requireSession } from "@/lib/auth/session";
import { getComisionesReconciliation } from "@/lib/comisionesbi";
import { ConciliacionWorkspace } from "@/features/conciliacion/conciliacion-workspace";
import type { ConciliacionResponse } from "@/types/comisiones";

// Cuatro semanas hasta hoy: suficiente para elegir entre varias sin arrancar
// con la pantalla vacía si la última semana completa todavía no cierra.
const DIAS_POR_DEFECTO = 28;

export default async function ConciliacionPage() {
  requireSession();

  let response: ConciliacionResponse | null = null;
  let error: string | null = null;

  const hoy = new Date();
  const desdeFecha = new Date(hoy);
  desdeFecha.setDate(desdeFecha.getDate() - DIAS_POR_DEFECTO);
  const hastaISO = hoy.toISOString().slice(0, 10);
  const desdeISO = desdeFecha.toISOString().slice(0, 10);

  try {
    response = await getComisionesReconciliation({
      division: null,
      comisionista: null,
      start_date: desdeISO,
      end_date: hastaISO
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "No se pudo generar la conciliación.";
  }

  return (
    <ConciliacionWorkspace
      initialError={error}
      initialResponse={response}
      rangoInicial={{ desde: desdeISO, hasta: hastaISO }}
    />
  );
}
