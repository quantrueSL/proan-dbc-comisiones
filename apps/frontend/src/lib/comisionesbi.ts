// Cliente del backend comisionesbi (FastAPI + BigQuery), sidecar sin URL
// pública en Cloud Run. Reemplaza al antiguo `lib/gateway.ts` de Hidrocarburos
// -- aquí no hay gateway/proxy, es una llamada directa de servidor a servidor
// dentro del mismo Pod (ver deploy/cloudrun/service.yaml).
import { getComisionesbiServiceUrl } from "@/lib/env";
import type {
  ComisionesCatalog,
  ConciliacionDiarioRow,
  ConciliacionFacturaRow,
  ConciliacionFilters,
  ConciliacionResponse,
  FlujoFilters,
  FlujoResponse,
  ReportFilters,
  ReportResponse
} from "@/types/comisiones";

// El backend usaba 501 cuando un módulo todavía no estaba construido. Ya no
// queda ninguno así (comisiones y conciliación calculan desde 2026-09), pero
// el tipo se queda por si el patrón vuelve a hacer falta.
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

export async function getFlujoProducto(filters: FlujoFilters): Promise<FlujoResponse> {
  return comisionesbiFetchJson<FlujoResponse>("/v1/comisionesbi/flujo", { method: "POST", body: filters });
}

export async function getComisionesReport(filters: ReportFilters): Promise<ReportResponse> {
  return comisionesbiFetchJson<ReportResponse>("/v1/comisionesbi/report", { method: "POST", body: filters });
}

export async function getComisionesReconciliation(filters: ConciliacionFilters): Promise<ConciliacionResponse> {
  return comisionesbiFetchJson<ConciliacionResponse>("/v1/comisionesbi/reconciliation", { method: "POST", body: filters });
}

/** Detalle día por día, sin agregar por periodo de pago -- para la pestaña de
 *  transparencia del Excel exportado (ver ConciliacionDiarioRow). */
export async function getComisionesReconciliationDiario(filters: ConciliacionFilters): Promise<ConciliacionDiarioRow[]> {
  return comisionesbiFetchJson<ConciliacionDiarioRow[]>("/v1/comisionesbi/reconciliation/diario", {
    method: "POST",
    body: filters
  });
}

/** Detalle a nivel línea de factura real, con cobro -- la hoja de máximo
 *  detalle del Excel exportado (ver ConciliacionFacturaRow). */
export async function getComisionesReconciliationFactura(filters: ConciliacionFilters): Promise<ConciliacionFacturaRow[]> {
  return comisionesbiFetchJson<ConciliacionFacturaRow[]>("/v1/comisionesbi/reconciliation/factura", {
    method: "POST",
    body: filters
  });
}
