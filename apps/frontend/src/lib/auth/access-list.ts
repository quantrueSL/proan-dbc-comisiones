import { normalizeSessionRole } from "@/lib/auth/roles";
import type { SessionRole } from "@/types/auth";

// ─────────────────────────────────────────────────────────────────────────
// Lista de acceso (LOGIN.md §4). Documento Firestore `lists/dbc_comisiones_acceso`
// en la base `proan-lista-mails`, la misma que gestiona Mailing-lists.
//
//   emails:  ["a@proan.com", "b@proan.com"]        ← quién entra
//   roles:   { "a@proan.com": "admin" }             ← qué puede hacer
//   enabled: true
//
// Reglas: `emails` es la puerta y `roles` solo reparte permisos. Un correo en
// `roles` que no esté en `emails` no entra; uno en `emails` sin rol entra como
// genérico. El rol se concede, nunca se hereda.
//
// Módulo puro: parsea y decide, no habla con Firestore (eso es
// access-list-firestore.ts). Así se puede testear la lógica sin red.
// ─────────────────────────────────────────────────────────────────────────

export type AccessList = {
  enabled: boolean;
  /** Correo normalizado → rol. Solo contiene correos autorizados. */
  entries: Record<string, SessionRole>;
};

export type AccessDenialReason =
  | "list-missing" // el documento no existe
  | "list-disabled" // enabled: false
  | "not-listed"; // el correo no está en emails

export type AccessDecision =
  | { status: "allowed"; role: SessionRole }
  | { status: "denied"; reason: AccessDenialReason }
  /** Firestore no respondió. Se deniega igual, pero se distingue para el aviso. */
  | { status: "unavailable" };

/** Los correos se comparan siempre normalizados, en los dos lados. */
export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readEnabled(raw: Record<string, unknown>): boolean {
  // Ausente → true, igual que hace Mailing-lists al guardar (utils.py).
  return raw.enabled === undefined ? true : Boolean(raw.enabled);
}

function readRoleMap(raw: Record<string, unknown>): Record<string, SessionRole> {
  const value = raw.roles;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const roles: Record<string, SessionRole> = {};
  for (const [key, role] of Object.entries(value as Record<string, unknown>)) {
    const email = normalizeEmail(key);
    if (email) {
      // Valor irreconocible → genérico. Una errata al teclear el rol quita
      // permisos, nunca los concede.
      roles[email] = normalizeSessionRole(role);
    }
  }
  return roles;
}

/** Convierte el documento crudo de Firestore en una lista utilizable. */
export function parseAccessList(raw: unknown): AccessList | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const document = raw as Record<string, unknown>;
  const roles = readRoleMap(document);
  const emails = Array.isArray(document.emails) ? document.emails : [];

  const entries: Record<string, SessionRole> = {};
  for (const rawEmail of emails) {
    const email = normalizeEmail(rawEmail);
    if (email) {
      entries[email] = roles[email] ?? "viewer";
    }
  }

  return { enabled: readEnabled(document), entries };
}

export function resolveAccessDecision(list: AccessList | null, email: string): AccessDecision {
  if (!list) {
    return { status: "denied", reason: "list-missing" };
  }
  if (!list.enabled) {
    return { status: "denied", reason: "list-disabled" };
  }

  const role = list.entries[normalizeEmail(email)];
  if (!role) {
    return { status: "denied", reason: "not-listed" };
  }

  return { status: "allowed", role };
}
