import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getSessionCookieName,
  getSessionSecret,
  isSecureSessionCookie
} from "@/lib/env";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session-token";
import type { FrontendSession } from "@/types/auth";

export function getSession(): FrontendSession | null {
  const cookieStore = cookies();
  const rawValue = cookieStore.get(getSessionCookieName())?.value;

  if (!rawValue) {
    return null;
  }

  // Firma inválida, cookie manipulada o sesión caducada → como si no hubiera
  // sesión. No se distingue el motivo hacia fuera.
  return verifySessionToken(rawValue, getSessionSecret());
}

export function requireSession(): FrontendSession {
  const session = getSession();

  if (!session) {
    redirect("/login");
  }

  return session;
}

export function setSession(session: FrontendSession): void {
  const cookieStore = cookies();
  const expiresAt = session.expiresAt ? new Date(session.expiresAt * 1000) : undefined;

  cookieStore.set({
    name: getSessionCookieName(),
    value: signSessionToken(session, getSessionSecret()),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSessionCookie(),
    path: "/",
    expires: expiresAt
  });
}

export function clearSession(): void {
  const cookieStore = cookies();
  cookieStore.delete(getSessionCookieName());
}

