import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getComisionesReconciliation } from "@/lib/comisionesbi";
import { ConciliacionWorkspace } from "@/features/conciliacion/conciliacion-workspace";
import type { ReconciliationResponse } from "@/types/comisiones";

export default async function ConciliacionPage() {
  requireSession();

  let response: ReconciliationResponse | null = null;
  let blockedMessage: string | null = null;
  let error: string | null = null;

  const now = new Date();
  const defaultEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  try {
    response = await getComisionesReconciliation({ provider_id: null, start_period: defaultEnd, end_period: defaultEnd });
  } catch (cause) {
    if (cause instanceof BackendNotReadyError) {
      blockedMessage = cause.message;
    } else {
      error = cause instanceof Error ? cause.message : "No se pudo cargar la conciliación.";
    }
  }

  return <ConciliacionWorkspace initialBlockedMessage={blockedMessage} initialError={error} initialResponse={response} />;
}
