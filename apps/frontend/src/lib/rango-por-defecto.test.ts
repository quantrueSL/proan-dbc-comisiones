import { describe, expect, it } from "vitest";
import { rangoPorDefectoCompartido } from "./rango-por-defecto";

describe("rangoPorDefectoCompartido", () => {
  it("empieza el día 1 de un mes, no 180 días atrás", () => {
    // Con "hoy menos 180 días" marzo habría empezado el 22, a mitad de mes.
    const { desde, hasta } = rangoPorDefectoCompartido(new Date("2026-09-22T12:00:00Z"));
    expect(desde).toBe("2026-04-01");
    expect(hasta).toBe("2026-09-22");
  });

  it("el mes en curso cuenta como uno de los 6", () => {
    const { desde } = rangoPorDefectoCompartido(new Date("2026-01-05T00:00:00Z"));
    // Enero (en curso) + dic/nov/oct/sep/ago -> agosto es el sexto mes.
    expect(desde).toBe("2025-08-01");
  });

  it("cruza el fin de año sin desfasarse", () => {
    const { desde, hasta } = rangoPorDefectoCompartido(new Date("2026-02-01T00:00:00Z"));
    expect(desde).toBe("2025-09-01");
    expect(hasta).toBe("2026-02-01");
  });
});
