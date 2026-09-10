import { requireSession } from "@/lib/auth/session";
import { getComisionesReconciliation } from "@/lib/comisionesbi";
import { ConciliacionWorkspace } from "@/features/conciliacion/conciliacion-workspace";
import type { ConciliacionResponse } from "@/types/comisiones";

// Fecha de México, no la del servidor -- el corte de "qué periodo ya se
// pagó" depende del calendario del cliente, no de en qué zona horaria corre
// el hosting. `en-CA` formatea como YYYY-MM-DD directo, sin parseo aparte.
function fechaMexicoISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
}

// Por defecto se abre en el último periodo YA PAGADO (2026-09-09, pedido de
// Silvana), no en el que todavía está corriendo: el pago real (BSAK) llega el
// viernes siguiente al cierre del periodo (sábado a viernes), así que un
// periodo queda "cerrado" en cuanto pasa ese viernes de pago -- entrar en uno
// más reciente aterriza en una pantalla sin "Pagado" que comparar todavía.
// No repite el recorte de fin de mes de `v1_conciliacion_producto_semanal.sql`
// (es solo el rango por defecto del filtro, el usuario lo puede mover): cerca
// del borde de un mes puede no coincidir exacto con el periodo real, pero es
// el caso raro, no el común.
function ultimoPeriodoCerrado(hoyISO: string): { desde: string; hasta: string } {
  const iso = (fecha: Date) => fecha.toISOString().slice(0, 10);
  const hoy = new Date(`${hoyISO}T00:00:00Z`);
  const umbral = new Date(hoy);
  umbral.setUTCDate(umbral.getUTCDate() - 7);
  const diasHastaViernes = (umbral.getUTCDay() - 5 + 7) % 7;
  const periodoFin = new Date(umbral);
  periodoFin.setUTCDate(periodoFin.getUTCDate() - diasHastaViernes);
  const periodoInicio = new Date(periodoFin);
  periodoInicio.setUTCDate(periodoInicio.getUTCDate() - 6);
  return { desde: iso(periodoInicio), hasta: iso(periodoFin) };
}

export default async function ConciliacionPage() {
  requireSession();

  let response: ConciliacionResponse | null = null;
  let error: string | null = null;

  const { desde: desdeISO, hasta: hastaISO } = ultimoPeriodoCerrado(fechaMexicoISO());

  try {
    response = await getComisionesReconciliation({
      division: null,
      comisionista_id: null,
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
