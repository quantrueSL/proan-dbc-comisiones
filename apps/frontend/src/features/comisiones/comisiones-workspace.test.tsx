import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComisionesWorkspace } from "@/features/comisiones/comisiones-workspace";
import { EMPTY_CATALOG, EMPTY_REPORT, type ReportResponse } from "@/types/comisiones";

// Esta pantalla enseña un número que todavía no está completo. Los tests fijan
// lo que no puede desaparecer de ella sin que ese número pase a leerse mal.

const INFORME: ReportResponse = {
  ...EMPTY_REPORT,
  cobertura: { desde: "2026-01-02", hasta: "2026-08-23" },
  totales: {
    num_lineas: 1_755_942,
    monto: 732_533_406,
    comision: 18_260_942,
    comision_con_cobro: 4_817_432,
    monto_calculable: 426_927_014,
    pct_calculable: 58.3,
    lineas_sin_importe: 12_434
  },
  por_comisionista: [
    {
      comisionista: "ELIAS BARBA",
      num_lineas: 100,
      monto: 10_000_000,
      comision: 1_159_105,
      comision_con_cobro: 300_000,
      monto_calculable: 10_000_000
    }
  ],
  por_division: [
    {
      division_code: "H",
      division: "Huevo",
      num_lineas: 100,
      monto: 352_021_615,
      comision: 11_512_783,
      comision_con_cobro: 0,
      monto_calculable: 300_000_000
    }
  ],
  bloqueado: [
    {
      motivo: "tarifa en conflicto entre hojas",
      num_lineas: 689_204,
      monto: 181_029_337,
      comision_min: 14_050_345,
      comision_max: 20_563_414
    },
    { motivo: "material sin SET", num_lineas: 76_745, monto: 12_366_785, comision_min: 0, comision_max: 0 }
  ]
};

function pantalla(informe: ReportResponse | null = INFORME, hasta = "2026-08-31") {
  return renderToStaticMarkup(
    <ComisionesWorkspace
      initialCatalog={EMPTY_CATALOG}
      initialError={null}
      initialReport={informe}
      rangoInicial={{ desde: "2026-01-01", hasta }}
    />
  );
}

function texto(...args: Parameters<typeof pantalla>) {
  return pantalla(...args).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("el periodo", () => {
  it("dice de qué fechas son las cifras, sin abrir los filtros", () => {
    // Estaba solo en el panel lateral, que arranca cerrado: se veían importes de
    // comisión sin saber de cuándo eran.
    expect(texto()).toMatch(/Del 1 de enero de 2026 al 31 de agosto de 2026/);
  });

  it("no resta un día al formatear la fecha", () => {
    // `new Date("2026-01-01")` se interpreta como UTC y en México sale el 31 de
    // diciembre. Es el fallo clásico y aquí saldría en el titular.
    expect(texto()).not.toMatch(/31 de diciembre/);
  });

  it("avisa cuando el rango pedido va más allá de los datos cargados", () => {
    // El aviso es un boton: su texto vive en `title`/`aria-label` hasta que
    // alguien lo pulsa, igual que en flujo de producto. Por eso se mira el
    // HTML y no el texto plano.
    expect(pantalla(INFORME, "2026-08-31")).toMatch(/va mas alla de los datos cargados|va más allá de los datos cargados/);
  });

  it("no avisa si el rango cabe dentro de los datos", () => {
    expect(pantalla(INFORME, "2026-08-01")).not.toMatch(/va más allá de los datos cargados/);
  });
});

describe("lo que no entra en el cálculo", () => {
  it("se enseña siempre, no detrás de un desplegable", () => {
    // Es lo que impide leer los $18,2 M como si fueran el total.
    expect(texto()).toMatch(/Lo que todavía no entra en el cálculo/);
    expect(texto()).toMatch(/tarifa en conflicto entre hojas/);
  });

  it("da la horquilla donde la hay y dice «sin determinar» donde no", () => {
    // Un 0 en esa columna parecería una cifra, y no lo es.
    const t = texto();
    expect(t).toMatch(/\$14,050,345\s*–\s*\$20,563,414/);
    expect(t).toMatch(/sin determinar/);
  });

  it("dice sobre cuánto del facturado se pudo calcular", () => {
    expect(texto()).toMatch(/58[.,]3%/);
  });
});

describe("las cifras que se leen mal por defecto", () => {
  it("aclara que lo cobrado es un suelo, no lo pagable", () => {
    expect(texto()).toMatch(/suelo conocido, no lo pagable/);
    expect(texto()).not.toMatch(/[Cc]omisión pagable/);
  });

  it("no queda ni rastro de los datos de ejemplo", () => {
    // La pantalla enseñaba una vista previa inventada mientras el módulo daba
    // 501. Si algo de aquello volviera, se mezclaría con datos reales.
    const t = texto();
    for (const rastro of [/vista previa/i, /Comisionista 1/, /CEDIS Culiacán/, /Balanceado/]) {
      expect(t).not.toMatch(rastro);
    }
  });
});

describe("el HTML que genera", () => {
  it("no mete el modal del aviso dentro de un párrafo", () => {
    // `<div>` dentro de `<p>` es inválido: el navegador cierra el párrafo antes
    // de tiempo y el aviso se sale de su sitio. Pasó al añadir el botón.
    const html = pantalla();
    // La frontera de palabra no sobra: sin ella, `<path>` del icono del
    // aviso cuenta como parrafo abierto y el test falla solo.
    const parrafos = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/g) ?? [];
    expect(parrafos.filter((p) => p.includes("<div"))).toEqual([]);
  });

  it("aguanta que no haya informe", () => {
    expect(() => pantalla(null)).not.toThrow();
  });
});
