// Cliente del backend comisionesbi (FastAPI + BigQuery), sidecar sin URL
// pública en Cloud Run. Reemplaza al antiguo `lib/gateway.ts` de Hidrocarburos
// -- aquí no hay gateway/proxy, es una llamada directa de servidor a servidor
// dentro del mismo Pod (ver deploy/cloudrun/service.yaml).
import { getComisionesbiServiceUrl } from "@/lib/env";
import type {
  ComisionesCatalog,
  ReconciliationFilters,
  ReconciliationResponse,
  ReportFilters,
  ReportResponse
} from "@/types/comisiones";

// El backend usa 501 a propósito (no un error genérico) cuando un módulo
// todavía no está construido -- ver comisiones_engine.py / conciliacion_engine.py.
// Se distingue con su propio tipo de error para que cada página pueda mostrar
// el motivo real en vez de un "algo salió mal" genérico.
export class BackendNotReadyError extends Error {}

type ComisionesbiFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

async function comisionesbiFetchJson<T>(path: string, options: ComisionesbiFetchOptions = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${getComisionesbiServiceUrl()}${path}`, {
      method: options.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
  } catch {
    throw new Error(`comisionesbi: no se pudo contactar el servicio (${path}).`);
  }

  const rawText = await response.text();
  let payload: unknown = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      payload = null;
    }
  }

  const detail =
    payload && typeof payload === "object" && "detail" in payload && typeof (payload as { detail?: unknown }).detail === "string"
      ? (payload as { detail: string }).detail
      : null;

  if (response.status === 501) {
    throw new BackendNotReadyError(detail || "Este módulo todavía no está disponible.");
  }

  if (!response.ok) {
    console.error("comisionesbi error", { path, status: response.status, detail });
    throw new Error("No se pudieron cargar los datos. Vuelve a intentarlo en unos instantes.");
  }

  return payload as T;
}

export async function getComisionesCatalog(): Promise<ComisionesCatalog> {
  return comisionesbiFetchJson<ComisionesCatalog>("/v1/comisionesbi/catalog");
}

export async function getComisionesReport(filters: ReportFilters): Promise<ReportResponse> {
  return comisionesbiFetchJson<ReportResponse>("/v1/comisionesbi/report", { method: "POST", body: filters });
}

export async function getComisionesReconciliation(filters: ReconciliationFilters): Promise<ReconciliationResponse> {
  return comisionesbiFetchJson<ReconciliationResponse>("/v1/comisionesbi/reconciliation", { method: "POST", body: filters });
}
