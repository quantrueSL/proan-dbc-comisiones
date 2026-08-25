import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlujoManual } from "@/features/flujo-producto/flujo-manual";
import { CAPAS, CORRIDA, ManualRecorrido } from "@/features/manual/manual-recorrido";
import { ManualGlosario, ManualIntro, ManualModulos } from "@/features/manual/manual-intro";
import { CON_CEDIS, PORCENTAJE_SIN, SIN_CEDIS, TOTAL } from "@/features/manual/manual-demos";
import { SECCIONES } from "@/features/manual/manual-secciones";
import type { FlujoCobertura } from "@/types/comisiones";

// El manual es documentación, y la documentación se pudre. Estos tests fijan lo
// que no puede desaparecer del manual nuevo: la explicación de qué es la app,
// el estado real de cada módulo, y que las animaciones no se hayan comido el
// texto —todo lo que se anima tiene que seguir estando en el HTML—.

const COBERTURA: FlujoCobertura = {
  vendido: { desde: "2026-01-01", hasta: "2026-07-20" },
  facturado: { desde: "2026-01-01", hasta: "2026-08-13" },
  cobrado: { desde: "2026-01-02", hasta: "2026-08-12" }
};

/** El manual entero, tal y como lo compone la página. */
function html() {
  return renderToStaticMarkup(
    <>
      <ManualIntro />
      <ManualRecorrido />
      <ManualModulos />
      <FlujoManual cobertura={COBERTURA} />
      <ManualGlosario />
    </>
  );
}

function texto() {
  return html().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("el índice y los apartados no pueden separarse", () => {
  it("cada entrada del índice tiene su apartado en el manual", () => {
    // Es el fallo silencioso de este diseño: se renombra un `id`, el índice
    // sigue enlazando al viejo y nadie lo nota hasta que alguien pulsa.
    const marcado = html();
    for (const seccion of SECCIONES) {
      expect(marcado, `falta el apartado ${seccion.id}`).toContain(`id="${seccion.id}"`);
    }
  });
});

describe("qué es la plataforma", () => {
  it("dice quién es DBC y qué hace la herramienta", () => {
    const contenido = texto();
    expect(contenido).toMatch(/DBC es el distribuidor del grupo Proan/);
    expect(contenido).toMatch(/CEDIS/);
  });

  it("dice de dónde salen los datos y desde cuándo", () => {
    // Sin esto, cualquiera supone que los datos se teclean en la app.
    const contenido = texto();
    expect(contenido).toMatch(/BigQuery/);
    expect(contenido).toMatch(/company_code/);
    expect(contenido).toMatch(/enero de 2026/);
  });

  it("explica que la comisión se devenga sobre lo compensado", () => {
    expect(texto()).toMatch(/Facturar no es cobrar/);
  });
});

describe("estado real de los módulos", () => {
  it("no presenta como terminado lo que está bloqueado", () => {
    const contenido = texto();
    expect(contenido).toMatch(/funcionando/);
    expect(contenido).toMatch(/bloqueado/);
  });

  it("dice qué falta exactamente en cada módulo bloqueado", () => {
    const contenido = texto();
    for (const pendiente of [/GS03/, /ZSDFI_001/, /rango de números de proveedor/]) {
      expect(contenido).toMatch(pendiente);
    }
  });

  it("deja claro que los módulos bloqueados no inventan datos", () => {
    // La promesa que sostiene la credibilidad de la herramienta.
    expect(texto()).toMatch(/501/);
  });
});

describe("las cuatro capas del recorrido", () => {
  it("son cuatro, en orden, y solo tres están resueltas", () => {
    expect(CAPAS.map((capa) => capa.clave)).toEqual([
      "traspasos",
      "vendido",
      "facturado",
      "cobrado"
    ]);
    expect(CAPAS.filter((capa) => capa.resuelta)).toHaveLength(3);
    expect(CAPAS.find((capa) => !capa.resuelta)?.clave).toBe("traspasos");
  });

  it("cada capa dice de qué tabla de SAP sale", () => {
    for (const capa of CAPAS) {
      expect(capa.fuente.length, `la capa ${capa.clave} no dice su fuente`).toBeGreaterThan(3);
    }
    expect(CAPAS.find((c) => c.clave === "traspasos")?.fuente).toMatch(/MB51/);
    expect(CAPAS.find((c) => c.clave === "cobrado")?.fuente).toMatch(/sap_pago/);
  });

  it("la capa sin validar no enseña cifras, y las demás sí", () => {
    // Publicar un número que no cuadra con el MB51 del cliente es peor que no
    // publicar ninguno.
    expect(CAPAS.find((c) => c.clave === "traspasos")?.cifras).toBeNull();
    for (const capa of CAPAS.filter((c) => c.resuelta)) {
      expect(capa.cifras?.lineas ?? 0).toBeGreaterThan(0);
      expect(capa.cifras?.monto ?? 0).toBeGreaterThan(0);
    }
  });

  it("avisa de que el importe de vendido no es el bueno", () => {
    expect(CAPAS.find((c) => c.clave === "vendido")?.monto).toMatch(/orientativo/);
    expect(CAPAS.find((c) => c.clave === "facturado")?.monto).toMatch(/fiable/);
  });

  it("las cifras llevan la fecha de su corrida a la vista", () => {
    // Un número sin fecha en un manual envejece mintiendo.
    expect(texto()).toContain(CORRIDA);
  });
});

describe("las demos no pueden contradecir al texto", () => {
  it("los tramos de «Sin asignar» suman el total que se enseña", () => {
    expect(CON_CEDIS + SIN_CEDIS).toBe(TOTAL);
  });

  it("el porcentaje del hueco es el mismo en la demo y en el texto", () => {
    // Ha bajado cuatro veces: 65% → 61% con el fallback por oficina → 1,2%
    // cuando el cliente aclaró que dos tercios de aquello eran divisiones que
    // no opera y almacenes centrales sin CEDIS → 0,2% al arreglar el cruce por
    // nombre de almacén. Este test es el que obliga a mover la demo y la frase
    // juntas en vez de dejar una mintiendo al lado de la otra.
    expect(PORCENTAJE_SIN).toBe(0.2);
    expect(texto()).toMatch(/el 0,2% del importe/);
  });

  it("los juguetes salen escritos en el HTML, no solo al pulsarlos", () => {
    // Si una demo solo existiera después de un clic, el manual no se podría
    // leer sin JavaScript ni imprimir.
    const contenido = texto();
    expect(contenido).toMatch(/Dibujarlo como un cero/);
    expect(contenido).toMatch(/Esconder «Sin asignar»/);
    expect(contenido).toMatch(/Sumarlo todo/);
  });
});

describe("glosario", () => {
  it("define las palabras que no se pueden adivinar", () => {
    const contenido = texto();
    for (const termino of [/CEDIS/, /Comisionista/, /Compensado/, /SET/, /Traspaso/, /Caja \(CJ\)/]) {
      expect(contenido).toMatch(termino);
    }
  });
});
