import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` se iza por encima de los imports, así que los dobles tienen que
// crearse con `vi.hoisted` o no existirían todavía cuando corre la factoría.
const { cookieStore, redirect } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  redirect: vi.fn()
}));

vi.mock("next/headers", () => ({ cookies: () => cookieStore }));
vi.mock("next/navigation", () => ({ redirect }));

import { clearSession, getSession, requireSession, setSession } from "@/lib/auth/session";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session-token";
import type { FrontendSession } from "@/types/auth";

const SECRETO = "secreto-de-pruebas-con-mas-de-32-caracteres";
const NOMBRE_COOKIE = "dbc_comisiones_session";

const SESION: FrontendSession = {
  token: "",
  email: "gema.gonzalez@proan.com",
  username: "gema.gonzalez@proan.com",
  displayName: "Gema González",
  gatewayUserId: "gema.gonzalez@proan.com",
  apps: [],
  role: "admin",
  expiresAt: 2_000_000_000 // año 2033
};

/** El `redirect` de Next corta la ejecución lanzando; un mock que devuelva
 *  normal dejaría seguir a `requireSession` y daría un falso verde. */
class RedirectError extends Error {}

function conCookie(valor: string | undefined) {
  cookieStore.get.mockReturnValue(valor === undefined ? undefined : { value: valor });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SESSION_SECRET", SECRETO);
  redirect.mockImplementation((destino: string) => {
    throw new RedirectError(destino);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSession", () => {
  it("devuelve null si no hay cookie", () => {
    conCookie(undefined);
    expect(getSession()).toBeNull();
  });

  it("devuelve la sesión si la cookie está bien firmada", () => {
    conCookie(signSessionToken(SESION, SECRETO));

    expect(getSession()).toMatchObject({
      email: "gema.gonzalez@proan.com",
      role: "admin",
      expiresAt: 2_000_000_000
    });
  });

  it("lee la cookie cuyo nombre dice SESSION_COOKIE_NAME", () => {
    vi.stubEnv("SESSION_COOKIE_NAME", "otra_cookie");
    conCookie(undefined);

    getSession();

    expect(cookieStore.get).toHaveBeenCalledWith("otra_cookie");
  });

  it("usa el nombre por defecto si la variable no está", () => {
    conCookie(undefined);
    getSession();
    expect(cookieStore.get).toHaveBeenCalledWith(NOMBRE_COOKIE);
  });

  it("devuelve null si el payload se cambió conservando la firma", () => {
    // El ataque que justifica la firma: colar rol admin reutilizando la firma
    // de una sesión legítima de viewer.
    const legitima = signSessionToken({ ...SESION, role: "viewer" }, SECRETO);
    const firma = legitima.split(".")[1];
    const payloadFalso = Buffer.from(JSON.stringify({ ...SESION, role: "admin" }), "utf8").toString(
      "base64url"
    );
    conCookie(`${payloadFalso}.${firma}`);

    expect(getSession()).toBeNull();
  });

  it("devuelve null si la cookie se firmó con otro secreto", () => {
    conCookie(signSessionToken(SESION, "otro-secreto-igual-de-largo-que-el-real"));
    expect(getSession()).toBeNull();
  });

  it("devuelve null si la sesión ya caducó", () => {
    conCookie(signSessionToken({ ...SESION, expiresAt: 1_000 }, SECRETO));
    expect(getSession()).toBeNull();
  });

  it("devuelve null si la cookie no tiene el formato esperado", () => {
    conCookie("basura-sin-punto");
    expect(getSession()).toBeNull();
  });
});

describe("requireSession", () => {
  it("devuelve la sesión cuando la hay", () => {
    conCookie(signSessionToken(SESION, SECRETO));
    expect(requireSession().email).toBe("gema.gonzalez@proan.com");
  });

  it("redirige a /login y no sigue ejecutando si no hay sesión", () => {
    conCookie(undefined);

    expect(() => requireSession()).toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

describe("setSession", () => {
  function cookieEscrita() {
    return cookieStore.set.mock.calls[0][0];
  }

  it("escribe un valor que getSession puede volver a leer", () => {
    setSession(SESION);

    // La propiedad que de verdad importa: lo que se escribe se puede verificar.
    expect(verifySessionToken(cookieEscrita().value, SECRETO)).toMatchObject({
      email: "gema.gonzalez@proan.com",
      role: "admin"
    });
  });

  it("marca la cookie httpOnly, sameSite lax y en la raíz", () => {
    setSession(SESION);

    expect(cookieEscrita()).toMatchObject({
      name: NOMBRE_COOKIE,
      httpOnly: true,
      sameSite: "lax",
      path: "/"
    });
  });

  it("convierte expiresAt de segundos a milisegundos", () => {
    // Un fallo aquí no rompe nada visible: deja cookies caducadas en 1970 o
    // válidas durante siglos.
    setSession(SESION);

    expect(cookieEscrita().expires).toEqual(new Date(2_000_000_000 * 1000));
  });

  it("deja la cookie de sesión (sin expires) si no hay caducidad", () => {
    setSession({ ...SESION, expiresAt: null });
    expect(cookieEscrita().expires).toBeUndefined();
  });

  it("no marca secure por defecto, para que funcione en http local", () => {
    setSession(SESION);
    expect(cookieEscrita().secure).toBe(false);
  });

  it("marca secure cuando SESSION_COOKIE_SECURE lo pide", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    setSession(SESION);
    expect(cookieEscrita().secure).toBe(true);
  });
});

describe("clearSession", () => {
  it("borra la cookie por su nombre", () => {
    clearSession();
    expect(cookieStore.delete).toHaveBeenCalledWith(NOMBRE_COOKIE);
  });

  it("borra la cookie renombrada si SESSION_COOKIE_NAME está puesto", () => {
    vi.stubEnv("SESSION_COOKIE_NAME", "otra_cookie");
    clearSession();
    expect(cookieStore.delete).toHaveBeenCalledWith("otra_cookie");
  });
});
