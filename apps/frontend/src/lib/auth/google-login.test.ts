import { describe, expect, it } from "vitest";
import { checkGoogleTokenClaims } from "@/lib/auth/google-login";

/** Forma real de los claims que devuelve verifyIdToken, recortada a lo que usamos. */
function claims(overrides: Record<string, unknown> = {}) {
  return {
    email: "pablocomavalbuena@gmail.com",
    email_verified: true,
    name: "Pablo Coma",
    firebase: { sign_in_provider: "google.com" },
    ...overrides
  };
}

describe("checkGoogleTokenClaims", () => {
  it("acepta un token de Google con correo verificado", () => {
    expect(checkGoogleTokenClaims(claims())).toEqual({
      ok: true,
      email: "pablocomavalbuena@gmail.com",
      displayName: "Pablo Coma"
    });
  });

  it("normaliza el correo a minúsculas", () => {
    const check = checkGoogleTokenClaims(claims({ email: "  Pablo@Gmail.COM " }));
    expect(check).toEqual({ ok: true, email: "pablo@gmail.com", displayName: "Pablo Coma" });
  });

  it("rechaza un token obtenido con correo y contraseña", () => {
    // El caso que motiva esta comprobación: el proyecto Firebase es compartido y
    // tiene el proveedor de contraseña habilitado con cuentas de otra
    // herramienta. Verificar la firma no distingue una vía de la otra.
    expect(checkGoogleTokenClaims(claims({ firebase: { sign_in_provider: "password" } }))).toEqual({
      ok: false,
      reason: "wrong-provider"
    });
  });

  it("rechaza otros proveedores federados", () => {
    for (const provider of ["microsoft.com", "facebook.com", "anonymous", "custom"]) {
      expect(checkGoogleTokenClaims(claims({ firebase: { sign_in_provider: provider } })).ok).toBe(false);
    }
  });

  it("rechaza un token sin el bloque firebase", () => {
    expect(checkGoogleTokenClaims(claims({ firebase: undefined }))).toEqual({
      ok: false,
      reason: "wrong-provider"
    });
    expect(checkGoogleTokenClaims(claims({ firebase: null }))).toEqual({
      ok: false,
      reason: "wrong-provider"
    });
    expect(checkGoogleTokenClaims(claims({ firebase: "google.com" }))).toEqual({
      ok: false,
      reason: "wrong-provider"
    });
  });

  it("rechaza un token sin correo", () => {
    expect(checkGoogleTokenClaims(claims({ email: undefined })).ok).toBe(false);
    expect(checkGoogleTokenClaims(claims({ email: "   " }))).toEqual({
      ok: false,
      reason: "no-email"
    });
  });

  it("exige el correo verificado", () => {
    expect(checkGoogleTokenClaims(claims({ email_verified: false }))).toEqual({
      ok: false,
      reason: "email-not-verified"
    });
    // Un valor que "parece" verdadero no vale: se exige el booleano.
    expect(checkGoogleTokenClaims(claims({ email_verified: "true" }))).toEqual({
      ok: false,
      reason: "email-not-verified"
    });
    expect(checkGoogleTokenClaims(claims({ email_verified: undefined }))).toEqual({
      ok: false,
      reason: "email-not-verified"
    });
  });

  it("deja el nombre en null si no viene", () => {
    expect(checkGoogleTokenClaims(claims({ name: undefined }))).toEqual({
      ok: true,
      email: "pablocomavalbuena@gmail.com",
      displayName: null
    });
  });

  it("rechaza lo que no es un objeto de claims", () => {
    expect(checkGoogleTokenClaims(null).ok).toBe(false);
    expect(checkGoogleTokenClaims("token").ok).toBe(false);
    expect(checkGoogleTokenClaims(undefined).ok).toBe(false);
  });
});
