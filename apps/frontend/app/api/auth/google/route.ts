import { NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { getAuthApp } from "@/lib/auth/firebase-admin";
import { checkGoogleTokenClaims, type GoogleTokenRejection } from "@/lib/auth/google-login";
import { resolveAccessDecisionForEmail } from "@/lib/auth/access-list-firestore";
import { clearSession, setSession } from "@/lib/auth/session";
import { getSessionTtlSeconds } from "@/lib/env";
import { getDefaultAuthenticatedRoute } from "../../../../client.config";

// firebase-admin es Node puro (no Edge) y lee credenciales del entorno.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────
// Login con Google (LOGIN.md Capa 2).
//
// El navegador hace el flujo con Google y manda aquí el ID token. El servidor:
//   1. verifica la firma del token contra el proyecto Firebase,
//   2. exige que la sesión venga de Google (no de correo/contraseña),
//   3. consulta la lista de acceso de Firestore para saber si entra y con qué rol,
//   4. emite LA MISMA cookie firmada que el login por .htpasswd.
//
// A partir de ese punto la aplicación no sabe por dónde entró nadie.
// ─────────────────────────────────────────────────────────────────────────

const REJECTION_DETAIL: Record<GoogleTokenRejection, string> = {
  "wrong-provider": "Esta vía de acceso requiere iniciar sesión con Google.",
  "no-email": "Google no ha proporcionado una dirección de correo.",
  "email-not-verified": "La cuenta de Google no tiene el correo verificado."
};

const SIN_ACCESO =
  "Tu cuenta no tiene acceso a Comisiones DBC. Pide que te añadan a la lista de acceso.";

export async function POST(request: Request) {
  let idToken: string;
  try {
    const body = (await request.json()) as { idToken?: unknown };
    idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  } catch {
    return NextResponse.json({ detail: "Cuerpo JSON inválido." }, { status: 400 });
  }

  if (!idToken) {
    return NextResponse.json({ detail: "Falta el token de identidad." }, { status: 400 });
  }

  // Sin `checkRevoked`: el token tiene segundos de vida y se canjea de inmediato
  // por nuestra propia cookie, así que la consulta extra a Firebase no aporta.
  let claims: unknown;
  try {
    claims = await getAuth(getAuthApp()).verifyIdToken(idToken);
  } catch (cause) {
    console.warn("Token de Google no verificable", cause);
    clearSession();
    return NextResponse.json({ detail: "No se pudo verificar tu identidad." }, { status: 401 });
  }

  const check = checkGoogleTokenClaims(claims);
  if (!check.ok) {
    clearSession();
    return NextResponse.json({ detail: REJECTION_DETAIL[check.reason] }, { status: 403 });
  }

  const decision = await resolveAccessDecisionForEmail(check.email);

  if (decision.status === "unavailable") {
    // Firestore no respondió. No se concede acceso por defecto; el .htpasswd
    // sigue siendo la vía de entrada mientras dure el problema.
    clearSession();
    return NextResponse.json(
      { detail: "No se pudo comprobar tu acceso. Vuelve a intentarlo en unos instantes." },
      { status: 503 }
    );
  }

  if (decision.status === "denied") {
    console.info("Acceso denegado por lista", { email: check.email, reason: decision.reason });
    clearSession();
    return NextResponse.json({ detail: SIN_ACCESO }, { status: 403 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + getSessionTtlSeconds();

  setSession({
    token: "google",
    email: check.email,
    username: check.email,
    displayName: check.displayName ?? check.email,
    gatewayUserId: check.email,
    apps: ["comisionesbi"],
    subject: check.email,
    role: decision.role,
    expiresAt
  });

  return NextResponse.json({ ok: true, redirectTo: getDefaultAuthenticatedRoute() });
}
