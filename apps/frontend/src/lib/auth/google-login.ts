// ─────────────────────────────────────────────────────────────────────────
// Comprobación de los claims de un token de Firebase ya verificado.
//
// Verificar la firma solo prueba que el token lo emitió NUESTRO proyecto de
// Firebase. No basta: ese proyecto es la capa de identidad compartida de todos
// los proyectos de Proan y tiene además habilitado el proveedor de correo y
// contraseña, con ~15 cuentas de sucursal de otra herramienta. Un token obtenido
// con contraseña es tan válido como uno obtenido con Google.
//
// Por eso aquí se exige explícitamente que la sesión venga de Google. Si no, un
// correo que algún día entre en la lista de acceso tendría dos puertas: la
// nuestra y la contraseña de la otra aplicación.
//
// Módulo puro: recibe los claims ya decodificados, no verifica firmas.
// ─────────────────────────────────────────────────────────────────────────

export const GOOGLE_SIGN_IN_PROVIDER = "google.com";

export type GoogleTokenRejection =
  | "wrong-provider" // el token no viene de Google
  | "no-email" // Google no entregó correo
  | "email-not-verified";

export type GoogleTokenCheck =
  | { ok: true; email: string; displayName: string | null }
  | { ok: false; reason: GoogleTokenRejection };

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSignInProvider(claims: Record<string, unknown>): string {
  const firebase = claims.firebase;
  if (typeof firebase !== "object" || firebase === null) {
    return "";
  }
  return readString((firebase as Record<string, unknown>).sign_in_provider);
}

export function checkGoogleTokenClaims(claims: unknown): GoogleTokenCheck {
  if (typeof claims !== "object" || claims === null) {
    return { ok: false, reason: "wrong-provider" };
  }

  const record = claims as Record<string, unknown>;

  if (readSignInProvider(record) !== GOOGLE_SIGN_IN_PROVIDER) {
    return { ok: false, reason: "wrong-provider" };
  }

  const email = readString(record.email).toLowerCase();
  if (!email) {
    return { ok: false, reason: "no-email" };
  }

  // Con Google el correo viene verificado por definición; se comprueba igual
  // porque es el claim que sostiene toda la autorización posterior.
  if (record.email_verified !== true) {
    return { ok: false, reason: "email-not-verified" };
  }

  const displayName = readString(record.name);
  return { ok: true, email, displayName: displayName || null };
}
