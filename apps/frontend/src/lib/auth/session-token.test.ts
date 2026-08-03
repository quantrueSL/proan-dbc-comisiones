import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session-token";
import type { FrontendSession } from "@/types/auth";

const SECRET = "secreto-de-prueba-suficientemente-largo-1234";
const NOW = 1_800_000_000;

function makeSession(overrides: Partial<FrontendSession> = {}): FrontendSession {
  return {
    token: "htpasswd",
    email: "viewer@proan.com",
    username: "viewer@proan.com",
    displayName: "viewer@proan.com",
    gatewayUserId: "viewer@proan.com",
    apps: ["comisionesbi"],
    subject: "viewer@proan.com",
    role: "viewer",
    expiresAt: NOW + 3600,
    ...overrides
  };
}

/** Firma un payload arbitrario con el mismo esquema, para simular sesiones ajenas. */
function signRaw(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

describe("verifySessionToken", () => {
  it("acepta una sesión recién firmada y devuelve los mismos datos", () => {
    const session = makeSession({ role: "admin" });
    const verified = verifySessionToken(signSessionToken(session, SECRET), SECRET, NOW);
    expect(verified).toEqual(session);
  });

  it("rechaza una firma hecha con otro secreto", () => {
    const token = signSessionToken(makeSession(), "otro-secreto-completamente-distinto");
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("rechaza un payload manipulado para escalar a admin", () => {
    // El ataque que esto cierra: coger la cookie propia, cambiar el rol y volver
    // a montarla. Sin la firma correcta no cuela.
    const token = signSessionToken(makeSession(), SECRET);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(makeSession({ role: "admin" })), "utf8").toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rechaza una firma manipulada", () => {
    const [payload, signature] = signSessionToken(makeSession(), SECRET).split(".");
    // Se voltea un byte real de la firma, no el último carácter del base64url:
    // en 32 bytes el carácter final solo aporta bits de relleno y cambiarlo
    // decodifica a la misma firma.
    const bytes = Buffer.from(signature, "base64url");
    bytes[0] ^= 0xff;
    expect(verifySessionToken(`${payload}.${bytes.toString("base64url")}`, SECRET, NOW)).toBeNull();
  });

  it("rechaza una firma de longitud distinta", () => {
    const [payload, signature] = signSessionToken(makeSession(), SECRET).split(".");
    const truncated = Buffer.from(signature, "base64url").subarray(0, 16).toString("base64url");
    expect(verifySessionToken(`${payload}.${truncated}`, SECRET, NOW)).toBeNull();
  });

  it("rechaza una sesión caducada aunque la firma sea válida", () => {
    const token = signSessionToken(makeSession({ expiresAt: NOW - 1 }), SECRET);
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("acepta una sesión que aún no ha caducado", () => {
    const token = signSessionToken(makeSession({ expiresAt: NOW + 1 }), SECRET);
    expect(verifySessionToken(token, SECRET, NOW)?.email).toBe("viewer@proan.com");
  });

  it("degrada a genérico un rol ausente o desconocido", () => {
    const sinRol = signRaw({ email: "x@proan.com", username: "x@proan.com", expiresAt: NOW + 60 });
    expect(verifySessionToken(sinRol, SECRET, NOW)?.role).toBe("viewer");

    const rolInventado = signRaw({ email: "x@proan.com", username: "x@proan.com", role: "root", expiresAt: NOW + 60 });
    expect(verifySessionToken(rolInventado, SECRET, NOW)?.role).toBe("viewer");
  });

  it("rechaza entradas que no son tokens", () => {
    expect(verifySessionToken("", SECRET, NOW)).toBeNull();
    expect(verifySessionToken("sinpunto", SECRET, NOW)).toBeNull();
    expect(verifySessionToken("demasiados.puntos.aqui", SECRET, NOW)).toBeNull();
    expect(verifySessionToken(".", SECRET, NOW)).toBeNull();
    // Cookie del formato antiguo (base64 sin firmar) — ya no vale.
    expect(verifySessionToken(Buffer.from(JSON.stringify(makeSession())).toString("base64url"), SECRET, NOW)).toBeNull();
  });

  it("rechaza un payload firmado que no es una sesión", () => {
    expect(verifySessionToken(signRaw({ hola: "mundo" }), SECRET, NOW)).toBeNull();
    expect(verifySessionToken(signRaw("texto"), SECRET, NOW)).toBeNull();
  });
});
