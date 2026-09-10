import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComisionesCascada,
  jerarquia,
  NIVELES_POR_COMISIONISTA,
  NIVELES_POR_DIVISION
} from "@/features/comisiones/comisiones-cascada";
import type { ComisionDesgloseRow } from "@/types/comisiones";

const hoja = (extra: Partial<ComisionDesgloseRow>): ComisionDesgloseRow => ({
  sociedad: "DBC",
  comisionista_id: "0000004276",
  comisionista: "ELIAS BARBA",
  division_code: "H",
  division: "Huevo",
  cedis: "Leon 1",
  oficina: "0016",
  set: "HSANJUAN",
  tipo_venta: "VTA EN RUTA",
  base_unidad: "kg",
  cantidad_base: 1_000,
  num_lineas: 10,
  monto: 1_000_000,
  comision: 100_000,
  comision_con_cobro: 10_000,
  monto_calculable: 1_000_000,
  monto_cobrado: 250_000,
  ...extra
});

// Dos divisiones bajo el mismo comisionista: es el caso que obliga a partir por
// división antes que por nada, porque kilos y cajas no se suman.
const FILAS: ComisionDesgloseRow[] = [
  hoja({}),
  hoja({ division_code: "BO", division: "Botana", base_unidad: "caja", set: "BOVUALA", cantidad_base: 500, comision: 40_000 }),
  hoja({ comisionista_id: "0000006001", comisionista: "JAIME ROJAS", cedis: "Queretaro", oficina: "0021", set: "HPORTALES", comision: 70_000 })
];

function pintar(filas = FILAS, niveles = NIVELES_POR_COMISIONISTA, extra = {}) {
  return renderToStaticMarkup(
    <ComisionesCascada encabezado="Comisionista" filas={filas} niveles={niveles} {...extra} />
  );
}

const texto = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("la cascada", () => {
  it("arranca cerrada: solo el primer nivel", () => {
    const html = pintar();
    // Una fila por comisionista y ninguna más: las filas de datos son las que
    // llevan `data-nivel` (la de la cabecera no).
    expect(html.match(/data-nivel=/g)).toHaveLength(2);
    expect(texto(html)).toMatch(/ELIAS BARBA/);
    expect(texto(html)).not.toMatch(/HSANJUAN/);
  });

  it("ordena el primer nivel por lo que se debe, no alfabéticamente", () => {
    // ELIAS BARBA suma 140.000 y JAIME ROJAS 70.000.
    const t = texto(pintar());
    expect(t.indexOf("ELIAS BARBA")).toBeLessThan(t.indexOf("JAIME ROJAS"));
  });

  it("ofrece abrir solo donde hay algo debajo", () => {
    // Cada comisionista tiene divisiones dentro, así que los dos traen botón.
    const html = pintar();
    expect(html.match(/class="cascada-mas"/g)).toHaveLength(2);
  });

  it("no enseña cantidad cuando la fila mezcla kilos con cajas", () => {
    // ELIAS BARBA tiene huevo (kg) y botana (caja): ese total no existe. La celda
    // va con un guion, NO con la suma de los dos números.
    const html = pintar([FILAS[0], FILAS[1]]);
    expect(texto(html)).not.toMatch(/1,500/);
    expect(texto(html)).toMatch(/—/);
  });

  it("sí la enseña, con su unidad, cuando la rama tiene una sola", () => {
    const html = pintar([FILAS[2]]);
    expect(texto(html)).toMatch(/1,000 kg/);
  });

  it("la fila padre lleva el total de todos sus hijos, no de los abiertos", () => {
    // Cerrada, ELIAS BARBA ya suma sus dos divisiones: 100.000 + 40.000.
    expect(texto(pintar([FILAS[0], FILAS[1]]))).toMatch(/\$140,000/);
  });

  it("muestra el monto cobrado a la derecha de facturado, sumado igual que el resto", () => {
    // Pedido de Silvana (2026-09-09). ELIAS BARBA suma sus dos divisiones:
    // 250,000 + 250,000 = 500,000, aunque estén cerradas.
    expect(texto(pintar([FILAS[0], FILAS[1]]))).toMatch(/\$500,000/);
  });

  it("dice qué parte del facturado llegó a tener tarifa", () => {
    // Sin esto, un nodo con comisión baja no se distingue de uno bloqueado.
    const html = pintar([hoja({ monto: 1_000_000, monto_calculable: 250_000 })]);
    expect(texto(html)).toMatch(/25%/);
  });

  it("da la columna de CEDIS solo cuando el CEDIS no es un nivel", () => {
    // En la cascada de comisionista el CEDIS es columna; en la de división es un
    // nivel, y repetirlo en columna sería escribir dos veces lo mismo.
    expect(pintar(FILAS, NIVELES_POR_COMISIONISTA, { columnaCedis: true })).toMatch(/<th>CEDIS<\/th>/);
    expect(pintar(FILAS, NIVELES_POR_DIVISION)).not.toMatch(/<th>CEDIS<\/th>/);
  });

  it("aguanta que no haya nada que desglosar", () => {
    expect(texto(pintar([]))).toMatch(/Sin comisión que desglosar/);
  });
});

describe("las jerarquías", () => {
  it("por comisionista parte por división, no por CEDIS", () => {
    // Es lo que garantiza que cada rama tenga una sola unidad de cálculo.
    expect(NIVELES_POR_COMISIONISTA).toHaveLength(2);
    expect(NIVELES_POR_COMISIONISTA[1].clave(FILAS[0])).toBe("H");
  });

  it("por división baja hasta el comisionista pasando por el CEDIS", () => {
    // La clave del nivel comisionista es el id, no el texto -- ver
    // NIVEL_COMISIONISTA en comisiones-cascada.tsx.
    expect(NIVELES_POR_DIVISION.map((n) => n.clave(FILAS[0]))).toEqual(["H", "Leon 1", "0000004276"]);
  });

  it("escribe la jerarquía a partir de los niveles, no a mano", () => {
    // Escrita a mano en la pantalla, el título podría decir una cosa y la tabla
    // hacer otra. Sale de los niveles, así que no puede desalinearse.
    expect(jerarquia(NIVELES_POR_DIVISION)).toBe("División → CEDIS → Comisionista → SET");
    expect(jerarquia(NIVELES_POR_COMISIONISTA)).toBe("Comisionista → División → SET");
  });

  it("acaba siempre en el SET, que es donde vive la tarifa", () => {
    for (const niveles of [NIVELES_POR_COMISIONISTA, NIVELES_POR_DIVISION]) {
      expect(jerarquia(niveles).endsWith("→ SET")).toBe(true);
    }
  });

  it("nombra los grupos sin clave en vez de dejarlos en blanco", () => {
    for (const nivel of [...NIVELES_POR_COMISIONISTA, ...NIVELES_POR_DIVISION]) {
      expect(nivel.vacio).toMatch(/^Sin /);
    }
  });
});
