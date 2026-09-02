import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendNotReadyError,
  getComisionesCatalog,
  getComisionesReconciliation,
  getComisionesReport,
  getFlujoProducto
} from "@/lib/comisionesbi";

const CATALOGO = { divisiones: [{ business_area_code: "H" }], cedis: [] };

const fetchMock = vi.fn();

function respuesta(status: number, cuerpo: string) {
  return new Response(cuerpo, { status });
}

// Una Response nueva por llamada: su cuerpo solo se puede leer una vez, así que
// reutilizar el objeto rompería cualquier test que llame dos veces.
function responde(status: number, cuerpo: unknown) {
  fetchMock.mockImplementation(async () => respuesta(status, JSON.stringify(cuerpo)));
}

function opcionesDeLaLlamada() {
  return fetchMock.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  // El módulo escribe en console.error en la rama de error; silenciado para no
  // ensuciar la salida de los tests, pero se sigue comprobando qué registra.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cómo se llama al backend", () => {
  it("pide el catálogo al sidecar de localhost por defecto", async () => {
    responde(200, CATALOGO);

    await getComisionesCatalog();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8091/v1/comisionesbi/catalog");
    expect(opcionesDeLaLlamada()).toMatchObject({ method: "GET" });
  });

  it("respeta COMISIONESBI_SERVICE_URL", async () => {
    vi.stubEnv("COMISIONESBI_SERVICE_URL", "http://comisionesbi:8091");
    responde(200, CATALOGO);

    await getComisionesCatalog();

    expect(fetchMock.mock.calls[0][0]).toBe("http://comisionesbi:8091/v1/comisionesbi/catalog");
  });

  it("nunca cachea la respuesta", async () => {
    // Los datos de comisión cambian con cada cierre; una respuesta cacheada por
    // Next se serviría entre despliegues sin que nadie lo note.
    responde(200, CATALOGO);

    await getComisionesCatalog();

    expect(opcionesDeLaLlamada()).toMatchObject({ cache: "no-store" });
  });

  it("manda el informe como POST con su cuerpo serializado", async () => {
    responde(200, { filas: [] });
    const filtros = {
      division: "H",
      cedis: "Leon 1",
      comisionista: null,
      start_date: "2026-01-01",
      end_date: "2026-01-31"
    };

    await getComisionesReport(filtros);

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8091/v1/comisionesbi/report");
    expect(opcionesDeLaLlamada()).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filtros)
    });
  });

  it("manda el flujo de producto con sus fechas ISO", async () => {
    responde(200, { resumen: [], cobertura: {} });
    const filtros = {
      division: "H",
      cedis: "Leon 1",
      start_date: "2026-07-01",
      end_date: "2026-07-31"
    };

    await getFlujoProducto(filtros);

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8091/v1/comisionesbi/flujo");
    expect(opcionesDeLaLlamada()).toMatchObject({
      method: "POST",
      body: JSON.stringify(filtros)
    });
  });

  it("manda null en los filtros vacíos del flujo, no cadenas vacías", async () => {
    // El backend distingue: null es "sin filtro", "" filtraría por cadena vacía
    // y no devolvería nada.
    responde(200, { resumen: [], cobertura: {} });

    await getFlujoProducto({
      division: null,
      cedis: null,
      start_date: "2026-07-01",
      end_date: "2026-07-31"
    });

    const cuerpo = JSON.parse(String(opcionesDeLaLlamada().body));
    expect(cuerpo.division).toBeNull();
    expect(cuerpo.cedis).toBeNull();
  });

  it("manda la conciliación a su propia ruta", async () => {
    responde(200, { por_comisionista: [], detalle: [] });

    await getComisionesReconciliation({
      division: null,
      comisionista: null,
      start_date: "2026-08-01",
      end_date: "2026-08-31"
    });

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8091/v1/comisionesbi/reconciliation");
  });

  it("devuelve el cuerpo ya parseado", async () => {
    responde(200, CATALOGO);
    await expect(getComisionesCatalog()).resolves.toEqual(CATALOGO);
  });
});

describe("errores", () => {
  it("distingue el 501 de módulo bloqueado y conserva el motivo del backend", async () => {
    // Ningún módulo devuelve 501 hoy (comisiones desde el 25/08, conciliación
    // desde el 02/09), pero el mecanismo se queda: si algún día vuelve a hacer
    // falta bloquear un módulo, la página tiene que poder seguir enseñando el
    // motivo en vez de un "algo salió mal" genérico.
    responde(501, { detail: "Falta explorar FBL1N / sap_bsik_open_items." });

    await expect(
      getComisionesReconciliation({ division: null, comisionista: null, start_date: "2026-08-01", end_date: "2026-08-31" })
    ).rejects.toThrow("Falta explorar FBL1N / sap_bsik_open_items.");
  });

  it("da un mensaje por defecto si el 501 llega sin detalle", async () => {
    responde(501, {});

    await expect(getComisionesCatalog()).rejects.toBeInstanceOf(BackendNotReadyError);
    await expect(getComisionesCatalog()).rejects.toThrow("todavía no está disponible");
  });

  it("el 503 de BigQuery caído NO es un módulo bloqueado", async () => {
    // Contrato con el backend: los 503 que devuelve app.py cuando BigQuery falla
    // tienen que caer por la rama genérica, no por la de "módulo no construido".
    responde(503, { detail: "No se pudo consultar el catálogo de divisiones." });

    const error = await getComisionesCatalog().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BackendNotReadyError);
    expect((error as Error).message).toContain("Vuelve a intentarlo");
  });

  it("no enseña al usuario el detalle técnico del error, pero sí lo registra", async () => {
    responde(503, { detail: "No se pudo consultar el catálogo de divisiones." });

    const error = await getComisionesCatalog().catch((e: unknown) => e);

    expect((error as Error).message).not.toContain("catálogo de divisiones");
    expect(console.error).toHaveBeenCalledWith("comisionesbi error", {
      path: "/v1/comisionesbi/catalog",
      status: 503,
      detail: "No se pudo consultar el catálogo de divisiones."
    });
  });

  it("avisa de forma distinta si el servicio ni siquiera responde", async () => {
    // Sidecar aún arrancando: en Cloud Run pandas y pyarrow tardan.
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(getComisionesCatalog()).rejects.toThrow("no se pudo contactar el servicio");
  });

  it("no revienta si el cuerpo del error no es JSON", async () => {
    // Un 502 de infraestructura llega como HTML, no como JSON.
    fetchMock.mockImplementation(async () => respuesta(502, "<html>Bad Gateway</html>"));

    await expect(getComisionesCatalog()).rejects.toThrow("Vuelve a intentarlo");
    expect(console.error).toHaveBeenCalledWith("comisionesbi error", {
      path: "/v1/comisionesbi/catalog",
      status: 502,
      detail: null
    });
  });

  it("tolera un 200 con el cuerpo vacío", async () => {
    fetchMock.mockImplementation(async () => respuesta(200, ""));
    await expect(getComisionesCatalog()).resolves.toBeNull();
  });
});
