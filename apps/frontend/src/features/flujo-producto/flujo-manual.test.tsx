import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlujoManual } from "@/features/flujo-producto/flujo-manual";
import type { FlujoCobertura } from "@/types/comisiones";

// El manual es documentación, y la documentación se pudre. Estos tests fijan lo
// que no puede desaparecer de él: las tres cosas que hacen que esta pantalla se
// lea mal si nadie las cuenta.

const COBERTURA: FlujoCobertura = {
  vendido: { desde: "2026-01-01", hasta: "2026-07-20" },
  facturado: { desde: "2026-01-01", hasta: "2026-08-13" },
  cobrado: { desde: "2026-01-02", hasta: "2026-08-12" }
};

function manual(cobertura: FlujoCobertura = COBERTURA) {
  const html = renderToStaticMarkup(<FlujoManual cobertura={cobertura} />);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("las tres trampas de la pantalla", () => {
  it("explica que una barra que falta no es un cero", () => {
    // Sin esto, alguien lee el día sin barra de vendido como ventas a cero.
    expect(manual()).toMatch(/falta la barra de una fase, es que no hay dato de ese día, no que fuera cero/);
  });

  it("explica qué es la fila «Sin asignar» y cuánto importe se lleva", () => {
    const texto = manual();
    expect(texto).toMatch(/Sin asignar/);
    expect(texto).toMatch(/el 0,2% del importe/);
  });

  it("avisa de que las cantidades no se suman entre unidades", () => {
    expect(manual()).toMatch(/no se suman/);
    expect(manual()).toMatch(/La única cantidad comparable es la de cajas/);
  });
});

describe("fechas de corte", () => {
  it("usa las fechas reales que le llegan, no unas escritas a mano", () => {
    // Si se codificaran a fuego, el manual mentiría en cuanto se arregle la
    // ingesta de SAP y vendido vuelva a estar al día.
    expect(manual()).toMatch(/2026-07-20/);
    expect(manual()).toMatch(/2026-08-13/);

    const otra = manual({
      vendido: { desde: "2026-01-01", hasta: "2026-09-30" },
      facturado: { desde: "2026-01-01", hasta: "2026-09-30" },
      cobrado: { desde: "2026-01-02", hasta: "2026-09-29" }
    });
    expect(otra).toMatch(/2026-09-30/);
    expect(otra).not.toMatch(/2026-07-20/);
  });

  it("no revienta si falta la cobertura de alguna fase", () => {
    expect(() => manual({})).not.toThrow();
  });
});

describe("pendientes", () => {
  it("deja documentado lo que falta y de qué depende", () => {
    const texto = manual();
    for (const pendiente of [/MB51/, /GS03/, /ZSDFI_001/, /rango de números de proveedor/]) {
      expect(texto).toMatch(pendiente);
    }
  });
});

describe("las tres fases", () => {
  it("dice que la comisión se paga sobre lo cobrado, no sobre lo vendido", () => {
    // Es la frase que evita el malentendido más caro del proyecto.
    expect(manual()).toMatch(/la comisión se paga sobre lo cobrado, no sobre lo vendido/);
  });

  it("advierte de que el importe de vendido es orientativo", () => {
    expect(manual()).toMatch(/el importe es orientativo/);
  });
});
