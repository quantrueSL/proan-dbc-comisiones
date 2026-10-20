// Cliente del backend comisionesbi (FastAPI + BigQuery), sidecar sin URL
// pública en Cloud Run. Reemplaza al antiguo `lib/gateway.ts` de Hidrocarburos
// -- aquí no hay gateway/proxy, es una llamada directa de servidor a servidor
// dentro del mismo Pod (ver deploy/cloudrun/service.yaml).
import { getComisionesbiServiceUrl } from "@/lib/env";
import type {
  ComisionesCatalog,
  CortesAccion,
  CortesDetalleFilters,
  CortesDetalleResponse,
  CortesFilaFilters,
  CortesFilaResponse,
  CortesMesFilters,
  CortesMesResponse,
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

// ── Conciliación por cortes (pestaña nueva) ─────────────────────────────────

/** La lista del mes: pagos por comisionista y división con su estado y sugerencia. */
export async function getCortesMes(filters: CortesMesFilters): Promise<CortesMesResponse> {
  return comisionesbiFetchJson<CortesMesResponse>("/v1/comisionesbi/cortes/mes", { method: "POST", body: filters });
}

/** El panel de un pago: todos los pagos cercanos de su fila y los cobros diarios. */
export async function getCortesFila(filters: CortesFilaFilters): Promise<CortesFilaResponse> {
  return comisionesbiFetchJson<CortesFilaResponse>("/v1/comisionesbi/cortes/fila", { method: "POST", body: filters });
}

/** Detalle por producto acotado a la ventana de un pago. */
export async function getCortesDetalle(filters: CortesDetalleFilters): Promise<CortesDetalleResponse> {
  return comisionesbiFetchJson<CortesDetalleResponse>("/v1/comisionesbi/cortes/detalle", { method: "POST", body: filters });
}

// ── Edición de cortes ───────────────────────────────────────────────────────

const RUTAS_EDICION: Record<CortesAccion | "historial", string> = {
  mover: "/v1/comisionesbi/cortes/mover",
  "mover-borde": "/v1/comisionesbi/cortes/mover-borde",
  aplicar: "/v1/comisionesbi/cortes/sugerencia/aplicar",
  descartar: "/v1/comisionesbi/cortes/sugerencia/descartar",
  recuperar: "/v1/comisionesbi/cortes/sugerencia/recuperar",
  restablecer: "/v1/comisionesbi/cortes/restablecer",
  consolidar: "/v1/comisionesbi/cortes/consolidar",
  reabrir: "/v1/comisionesbi/cortes/reabrir",
  "consolidar-lote": "/v1/comisionesbi/cortes/consolidar-lote",
  "fijar-ventana": "/v1/comisionesbi/cortes/fijar-ventana",
  "asignar-dias": "/v1/comisionesbi/cortes/asignar-dias",
  "quitar-huerfano": "/v1/comisionesbi/cortes/quitar-huerfano",
  historial: "/v1/comisionesbi/cortes/historial"
};

export function esAccionDeEdicion(valor: string): valor is CortesAccion | "historial" {
  return Object.prototype.hasOwnProperty.call(RUTAS_EDICION, valor);
}

/**
 * Una edición (o la lectura del historial) tal cual la responde el backend: se devuelven estado y
 * cuerpo sin tocar, porque el 409 de un conflicto de versión y el 422 de un corte inválido traen un
 * mensaje que la pantalla tiene que poder mostrar (a diferencia de las lecturas, que lo ocultan).
 * `usuario` y `rol` salen de la sesión del servidor, nunca del cuerpo de la petición.
 */
export async function postCortesEdicion(
  accion: CortesAccion | "historial",
  cuerpo: unknown,
  sesion: { usuario: string; rol: string }
): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${getComisionesbiServiceUrl()}${RUTAS_EDICION[accion]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-usuario": sesion.usuario, "x-rol": sesion.rol },
      body: JSON.stringify(cuerpo),
      cache: "no-store"
    });
  } catch {
    throw new Error("comisionesbi: no se pudo contactar el servicio.");
  }
  const texto = await response.text();
  let payload: unknown = null;
  try {
    payload = texto ? (JSON.parse(texto) as unknown) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}
