import { createHmac, timingSafeEqual } from "node:crypto";
import type { FrontendSession } from "@/types/auth";
import { normalizeSessionRole } from "@/lib/auth/roles";

// ─────────────────────────────────────────────────────────────────────────
// Sesión firmada (HMAC-SHA256).
//
// Antes la cookie era JSON en base64 plano: cualquiera podía fabricarse una
// sesión con el rol que quisiera. Aquí el payload sigue siendo legible (no es
// secreto: correo, rol y caducidad), pero va acompañado de una firma que solo
// puede generar quien conoce SESSION_SECRET.
//
// Formato:  <base64url(payload JSON)>.<base64url(HMAC del payload)>
//
// Módulo deliberadamente puro (sin next/headers) para poder testearlo; el
// manejo de la cookie vive en session.ts.
// ─────────────────────────────────────────────────────────────────────────

const SEPARATOR = ".";

function encodeBase64Url(value: Buffer | string): string {
  return (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).toString("base64url");
}

function computeSignature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Compara dos firmas en tiempo constante; longitudes distintas → no coinciden. */
function signaturesMatch(expected: Buffer, received: Buffer): boolean {
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

export function signSessionToken(session: FrontendSession, secret: string): string {
  const payload = encodeBase64Url(JSON.stringify(session));
  return `${payload}${SEPARATOR}${encodeBase64Url(computeSignature(payload, secret))}`;
}

/**
 * Devuelve la sesión solo si la firma es válida y no ha caducado. En cualquier
 * otro caso devuelve null, que el llamante trata como "no hay sesión".
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): FrontendSession | null {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }

  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (!signaturesMatch(computeSignature(payload, secret), received)) {
    return null;
  }

  let parsed: Partial<FrontendSession>;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<FrontendSession>;
  } catch {
    return null;
  }

  if (typeof parsed.email !== "string" || typeof parsed.username !== "string") {
    return null;
  }

  // La caducidad se comprueba aquí, no solo en el navegador: una cookie copiada
  // sigue siendo válida para el cliente hasta que el servidor la rechaza.
  if (typeof parsed.expiresAt === "number" && parsed.expiresAt <= nowSeconds) {
    return null;
  }

  return {
    token: typeof parsed.token === "string" ? parsed.token : "",
    email: parsed.email,
    username: parsed.username,
    displayName: typeof parsed.displayName === "string" ? parsed.displayName : null,
    gatewayUserId: typeof parsed.gatewayUserId === "string" ? parsed.gatewayUserId : parsed.username,
    apps: Array.isArray(parsed.apps) ? parsed.apps.filter((app): app is string => typeof app === "string") : [],
    subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
    // Rol ausente o desconocido → el menos privilegiado, nunca el contrario.
    role: normalizeSessionRole(parsed.role),
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null
  };
}
