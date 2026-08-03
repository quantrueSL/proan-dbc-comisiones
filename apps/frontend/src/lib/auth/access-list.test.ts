import { describe, expect, it } from "vitest";
import { normalizeEmail, parseAccessList, resolveAccessDecision } from "@/lib/auth/access-list";

// Adaptado del documento real de proan-hidrocarburos (mismo patrón de
// Firestore, ver LOGIN.md), campos extra incluidos y sin `comment`.
const DOCUMENTO_REAL = {
  emails: ["pablocomavalbuena@gmail.com", "fromeominorqt@gmail.com"],
  enabled: true,
  name: "Acceso Comisiones DBC",
  roles: {
    "fromeominorqt@gmail.com": "admin",
    "pablocomavalbuena@gmail.com": "viewer"
  },
  updated_at: new Date("2026-07-29T09:50:21.000Z"),
  updated_by: "consola"
};

describe("parseAccessList sobre el documento real", () => {
  it("resuelve los dos roles configurados", () => {
    const list = parseAccessList(DOCUMENTO_REAL);
    expect(list).toEqual({
      enabled: true,
      entries: {
        "pablocomavalbuena@gmail.com": "viewer",
        "fromeominorqt@gmail.com": "admin"
      }
    });
  });

  it("ignora los campos que no le incumben", () => {
    // name, updated_at y updated_by no deben estorbar, y la falta de `comment`
    // tampoco: el documento se creó sin él.
    expect(parseAccessList(DOCUMENTO_REAL)?.enabled).toBe(true);
  });
});

describe("parseAccessList", () => {
  it("da genérico a quien está en emails sin entrada en roles", () => {
    const list = parseAccessList({ emails: ["sin.rol@proan.com"], roles: {} });
    expect(list?.entries).toEqual({ "sin.rol@proan.com": "viewer" });
  });

  it("ignora entradas de roles que no están en emails", () => {
    // `emails` es la puerta: conceder un rol no da acceso por sí solo.
    const list = parseAccessList({
      emails: ["dentro@proan.com"],
      roles: { "dentro@proan.com": "admin", "fuera@proan.com": "admin" }
    });
    expect(list?.entries).toEqual({ "dentro@proan.com": "admin" });
    expect(resolveAccessDecision(list, "fuera@proan.com")).toEqual({ status: "denied", reason: "not-listed" });
  });

  it("degrada a genérico un rol mal escrito", () => {
    // El caso realista: teclear "administrador" o "Admin" en la consola.
    const list = parseAccessList({
      emails: ["a@proan.com", "b@proan.com", "c@proan.com"],
      roles: { "a@proan.com": "administrador", "b@proan.com": "Admin", "c@proan.com": 1 }
    });
    expect(list?.entries).toEqual({
      "a@proan.com": "viewer",
      "b@proan.com": "viewer",
      "c@proan.com": "viewer"
    });
  });

  it("normaliza mayúsculas y espacios en los dos lados", () => {
    const list = parseAccessList({
      emails: ["  Gema.Gonzalez@Proan.com  "],
      roles: { "GEMA.GONZALEZ@proan.com": "admin" }
    });
    expect(resolveAccessDecision(list, " gema.gonzalez@PROAN.com ")).toEqual({
      status: "allowed",
      role: "admin"
    });
  });

  it("enabled ausente equivale a true, como en Mailing-lists", () => {
    expect(parseAccessList({ emails: ["a@proan.com"] })?.enabled).toBe(true);
  });

  it("tolera formas inesperadas sin reventar", () => {
    expect(parseAccessList({ emails: "no-es-lista", roles: [] })?.entries).toEqual({});
    expect(parseAccessList({ emails: [null, 42, "", "ok@proan.com"] })?.entries).toEqual({
      "ok@proan.com": "viewer"
    });
    expect(parseAccessList(null)).toBeNull();
    expect(parseAccessList([])).toBeNull();
    expect(parseAccessList("texto")).toBeNull();
  });
});

describe("resolveAccessDecision", () => {
  const list = parseAccessList(DOCUMENTO_REAL);

  it("permite a quien está en la lista, con su rol", () => {
    expect(resolveAccessDecision(list, "fromeominorqt@gmail.com")).toEqual({
      status: "allowed",
      role: "admin"
    });
    expect(resolveAccessDecision(list, "pablocomavalbuena@gmail.com")).toEqual({
      status: "allowed",
      role: "viewer"
    });
  });

  it("deniega a quien no está", () => {
    expect(resolveAccessDecision(list, "cualquiera@gmail.com")).toEqual({
      status: "denied",
      reason: "not-listed"
    });
  });

  it("deniega si la lista está deshabilitada, aunque el correo figure", () => {
    const apagada = parseAccessList({ ...DOCUMENTO_REAL, enabled: false });
    expect(resolveAccessDecision(apagada, "fromeominorqt@gmail.com")).toEqual({
      status: "denied",
      reason: "list-disabled"
    });
  });

  it("deniega si el documento no existe", () => {
    expect(resolveAccessDecision(null, "fromeominorqt@gmail.com")).toEqual({
      status: "denied",
      reason: "list-missing"
    });
  });

  it("no concede acceso con un correo vacío", () => {
    expect(resolveAccessDecision(list, "").status).toBe("denied");
  });
});

describe("normalizeEmail", () => {
  it("recorta y pasa a minúsculas", () => {
    expect(normalizeEmail("  A@B.com ")).toBe("a@b.com");
  });

  it("convierte lo que no es texto en cadena vacía", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(42)).toBe("");
  });
});
