import { describe, expect, it } from "vitest";
import {
  agruparSerie,
  etiquetaEje,
  granoQueCabe,
  rotuloGrupo
} from "@/features/flujo-producto/flujo-serie";

// La gráfica de barras no se puede renderizar en test (no hay jsdom y el SVG
// solo se dibuja cuando el ResizeObserver ha medido el contenedor), así que lo
// que se fija aquí es lo que puede fallar en silencio: el grano y el hueco. Un
// grano mal elegido dibuja una gráfica preciosa donde cada barra vale siete
// veces lo que parece, y un hueco convertido en cero dice que ese día no se
// vendió nada.

/** Días consecutivos desde una fecha, en UTC. */
function dias(desde: string, cuantos: number): string[] {
  const salida: string[] = [];
  for (let i = 0; i < cuantos; i += 1) {
    const fecha = new Date(`${desde}T00:00:00Z`);
    fecha.setUTCDate(fecha.getUTCDate() + i);
    salida.push(fecha.toISOString().slice(0, 10));
  }
  return salida;
}

// Lo que ocupa un grupo de tres barras con su separación, igual que en
// flujo-chart.tsx: 3 barras de 3 px pegadas, más el 30% del paso que se reserva
// como aire entre un día y el siguiente → 9 / 0,7 ≈ 13.
const PASO_MIN = 13;

describe("qué grano cabe", () => {
  it("deja el día en un rango corto (mes y medio)", () => {
    // Cualquier rango de hasta ~1-2 meses (el que queda al pulsar un mes
    // suelto, o al acotar el periodo a mano) tiene que verse día a día. Si
    // esto pasara a semanas, la pantalla mentiría de entrada.
    expect(granoQueCabe(dias("2026-07-01", 52), 900, PASO_MIN)).toBe("dia");
  });

  it("pasa a semanas cuando se piden ocho meses", () => {
    // 240 días en 900 px son 3,75 px por grupo: menos que una sola barra.
    expect(granoQueCabe(dias("2026-01-01", 240), 900, PASO_MIN)).toBe("semana");
  });

  it("pasa a meses cuando un año no cabe ni por semanas", () => {
    expect(granoQueCabe(dias("2026-01-01", 365), 200, PASO_MIN)).toBe("mes");
  });

  it("no se atraganta sin fechas", () => {
    expect(granoQueCabe([], 900, PASO_MIN)).toBe("dia");
  });
});

describe("agrupar la serie", () => {
  const filas = [
    { fecha: "2026-08-03", fase: "facturado", monto: 100 }, // lunes
    { fecha: "2026-08-09", fase: "facturado", monto: 20 }, // domingo, misma semana
    { fecha: "2026-08-10", fase: "facturado", monto: 7 }, // lunes siguiente
    { fecha: "2026-08-03", fase: "vendido", monto: 50 }
  ];

  it("mete la semana de lunes a domingo, no de domingo a sábado", () => {
    const { claves, series } = agruparSerie(filas, (f) => f.monto, "semana");
    expect(claves).toEqual(["2026-08-03", "2026-08-10"]);
    expect(series.get("facturado")).toEqual([120, 7]);
  });

  it("agrupa por mes con la clave del año y el mes", () => {
    const { claves } = agruparSerie(filas, (f) => f.monto, "mes");
    expect(claves).toEqual(["2026-08"]);
  });

  it("deja en null la fase sin dato en vez de ponerla a cero", () => {
    // El caso real: hoy las cajas solo existen en facturado. Un cero aquí
    // dibujaría una barra diciendo "cero cajas vendidas".
    const conCajas = [
      { fecha: "2026-08-03", fase: "facturado", cajas: 30 as number | null },
      { fecha: "2026-08-03", fase: "vendido", cajas: null }
    ];
    const { series } = agruparSerie(conCajas, (f) => f.cajas, "dia");
    expect(series.get("facturado")).toEqual([30]);
    expect(series.get("vendido")).toEqual([null]);
    expect(series.get("cobrado")).toEqual([null]);
  });

  it("baja el suelo del eje cuando hay importes negativos", () => {
    // Existe de verdad: un día de facturado a -24,3 millones por notas de
    // crédito. Con el suelo clavado en cero, esa barra se dibujaba fuera.
    const { pisoEje, techoEje } = agruparSerie(
      [
        { fecha: "2026-03-02", fase: "facturado", monto: -24305614 },
        { fecha: "2026-03-03", fase: "facturado", monto: 1000000 }
      ],
      (f) => f.monto,
      "dia"
    );
    expect(pisoEje).toBe(-25000000);
    expect(techoEje).toBe(1000000);
  });

  it("deja el suelo en cero cuando no hay negativos", () => {
    const { pisoEje } = agruparSerie(filas, (f) => f.monto, "dia");
    expect(pisoEje).toBe(0);
  });
});

describe("cómo se rotula un grupo", () => {
  it("dice el periodo completo de una semana", () => {
    expect(rotuloGrupo("2026-08-03", "semana")).toBe("Semana del 03/08 al 09/08");
  });

  it("dice el mes con su año", () => {
    expect(rotuloGrupo("2026-08", "mes")).toBe("Agosto 2026");
  });

  it("en grano diario deja la fecha tal cual", () => {
    expect(rotuloGrupo("2026-08-03", "dia")).toBe("2026-08-03");
  });

  it("añade el año a la etiqueta del eje solo si el rango cruza de año", () => {
    expect(etiquetaEje("2026-01", "mes", false)).not.toMatch(/26/);
    expect(etiquetaEje("2026-01", "mes", true)).toMatch(/26$/);
  });
});
