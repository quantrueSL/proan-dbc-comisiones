import type { FrontendSession, SessionRole } from "@/types/auth";

// ─────────────────────────────────────────────────────────────────────────
// Roles de sesión (ver LOGIN.md §3).
//
//   admin   → puede todo.
//   viewer  → solo consulta.
//
// PROVISIONAL: todavía no se han definido con el cliente los roles reales de
// Comisiones DBC (por ejemplo, podría necesitarse un rol por CEDIS o por
// función comercial en vez de este admin/viewer genérico). Ajustar aquí y en
// SESSION_ROLES cuando se conozcan.
//
// El rol vive en la sesión firmada del servidor. Nunca se lee del body ni de
// nada que el cliente pueda escribir.
// ─────────────────────────────────────────────────────────────────────────

export const SESSION_ROLES = ["admin", "viewer"] as const;

export const DEFAULT_SESSION_ROLE: SessionRole = "viewer";

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}

/** Rol desconocido o ausente → el menos privilegiado (fail-closed). */
export function normalizeSessionRole(value: unknown): SessionRole {
  return isSessionRole(value) ? value : DEFAULT_SESSION_ROLE;
}

export function isAdmin(session: Pick<FrontendSession, "role"> | null): boolean {
  return session?.role === "admin";
}
