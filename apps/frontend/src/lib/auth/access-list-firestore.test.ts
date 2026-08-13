import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dobles izados: `vi.mock` corre antes que los imports. Se mockea también
// firebase-admin para que ningún test intente resolver credenciales reales.
const { getFirestore, getAuthApp, get, doc, collection, APP } = vi.hoisted(() => {
  const APP = { name: "dbc-comisiones-auth" };
  const get = vi.fn();
  const doc = vi.fn(() => ({ get }));
  const collection = vi.fn(() => ({ doc }));
  return {
    APP,
    get,
    doc,
    collection,
    getFirestore: vi.fn(() => ({ collection })),
    getAuthApp: vi.fn(() => APP)
  };
});

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));
vi.mock("@/lib/auth/firebase-admin", () => ({ getAuthApp }));

import { invalidateAccessListCache, resolveAccessDecisionForEmail } from "@/lib/auth/access-list-firestore";

const DOCUMENTO = {
  emails: ["gema.gonzalez@proan.com", "silvana@proan.com"],
  enabled: true,
  roles: { "gema.gonzalez@proan.com": "admin" }
};

function documentoEncontrado(datos: unknown = DOCUMENTO) {
  get.mockResolvedValue({ exists: true, data: () => datos });
}

function documentoInexistente() {
  get.mockResolvedValue({ exists: false, data: () => undefined });
}

let ahora = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAccessListCache();
  ahora = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => ahora);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateAccessListCache();
});

describe("de dónde se lee la lista", () => {
  it("lee lists/dbc_comisiones_acceso en la base con nombre", async () => {
    // Si esto se rompiera se leería la base por defecto, que está vacía: todo el
    // mundo quedaría fuera con un "no estás en la lista" que parece un problema
    // de permisos y no de código.
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    expect(getFirestore).toHaveBeenCalledWith(APP, "proan-lista-mails");
    expect(collection).toHaveBeenCalledWith("lists");
    expect(doc).toHaveBeenCalledWith("dbc_comisiones_acceso");
  });

  it("respeta FIRESTORE_DATABASE_ID y ACCESS_LIST_ID", async () => {
    vi.stubEnv("FIRESTORE_DATABASE_ID", "otra-base");
    vi.stubEnv("ACCESS_LIST_ID", "otra_lista");
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    expect(getFirestore).toHaveBeenCalledWith(APP, "otra-base");
    expect(doc).toHaveBeenCalledWith("otra_lista");
  });
});

describe("decisión de acceso", () => {
  it("deja entrar a quien está en la lista, con su rol", async () => {
    documentoEncontrado();

    await expect(resolveAccessDecisionForEmail("gema.gonzalez@proan.com")).resolves.toEqual({
      status: "allowed",
      role: "admin"
    });
  });

  it("da viewer a quien está en emails sin rol asignado", async () => {
    documentoEncontrado();

    await expect(resolveAccessDecisionForEmail("silvana@proan.com")).resolves.toEqual({
      status: "allowed",
      role: "viewer"
    });
  });

  it("deniega a quien no está", async () => {
    documentoEncontrado();

    await expect(resolveAccessDecisionForEmail("cualquiera@gmail.com")).resolves.toEqual({
      status: "denied",
      reason: "not-listed"
    });
  });

  it("deniega si el documento no existe", async () => {
    documentoInexistente();

    await expect(resolveAccessDecisionForEmail("gema.gonzalez@proan.com")).resolves.toEqual({
      status: "denied",
      reason: "list-missing"
    });
  });
});

describe("caché", () => {
  it("no vuelve a leer Firestore dentro del TTL", async () => {
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");
    ahora += 44_000;
    await resolveAccessDecisionForEmail("silvana@proan.com");

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("relee cuando vence el TTL", async () => {
    // El TTL es la ventana en la que un alta o una baja tarda en surtir efecto.
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");
    ahora += 46_000;
    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("una baja deja de tener acceso al vencer el TTL", async () => {
    documentoEncontrado();
    await expect(resolveAccessDecisionForEmail("silvana@proan.com")).resolves.toMatchObject({
      status: "allowed"
    });

    documentoEncontrado({ ...DOCUMENTO, emails: ["gema.gonzalez@proan.com"] });
    ahora += 46_000;

    await expect(resolveAccessDecisionForEmail("silvana@proan.com")).resolves.toEqual({
      status: "denied",
      reason: "not-listed"
    });
  });

  it("con TTL 0 lee en cada consulta", async () => {
    vi.stubEnv("ACCESS_LIST_CACHE_TTL_SECONDS", "0");
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");
    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("invalidateAccessListCache fuerza la relectura", async () => {
    documentoEncontrado();

    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");
    invalidateAccessListCache();
    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("N consultas simultáneas con la caché fría son UNA sola lectura", async () => {
    // Sin el `inFlight`, una ráfaga de logins tras un arranque en frío sería una
    // lectura de Firestore por login.
    let resolver: (valor: unknown) => void = () => {};
    get.mockReturnValue(
      new Promise((resolve) => {
        resolver = resolve;
      })
    );

    const consultas = Promise.all(
      Array.from({ length: 5 }, () => resolveAccessDecisionForEmail("gema.gonzalez@proan.com"))
    );
    resolver({ exists: true, data: () => DOCUMENTO });

    const decisiones = await consultas;

    expect(get).toHaveBeenCalledTimes(1);
    expect(decisiones).toEqual(Array.from({ length: 5 }, () => ({ status: "allowed", role: "admin" })));
  });
});

describe("Firestore no disponible", () => {
  it("devuelve unavailable en vez de reventar, y lo registra", async () => {
    get.mockRejectedValue(new Error("PERMISSION_DENIED"));

    await expect(resolveAccessDecisionForEmail("gema.gonzalez@proan.com")).resolves.toEqual({
      status: "unavailable"
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("no memoriza el fallo: la siguiente consulta vuelve a intentarlo", async () => {
    // Cachear un error alargaría la avería más allá de su causa.
    get.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    documentoEncontrado();

    await expect(resolveAccessDecisionForEmail("gema.gonzalez@proan.com")).resolves.toEqual({
      status: "allowed",
      role: "admin"
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("no sirve una copia caducada de la caché", async () => {
    // Justo lo contrario que el catálogo del backend: aquí servir una lista
    // vieja mantendría dentro a un usuario dado de baja.
    documentoEncontrado();
    await resolveAccessDecisionForEmail("gema.gonzalez@proan.com");

    ahora += 46_000;
    get.mockRejectedValue(new Error("UNAVAILABLE"));

    await expect(resolveAccessDecisionForEmail("gema.gonzalez@proan.com")).resolves.toEqual({
      status: "unavailable"
    });
  });
});
