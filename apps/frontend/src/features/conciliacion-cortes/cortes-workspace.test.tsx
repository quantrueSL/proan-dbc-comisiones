import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CortesWorkspace } from "@/features/conciliacion-cortes/cortes-workspace";
import {
  EMPTY_CATALOG,
  type CortesEstado,
  type CortesFila,
  type CortesMesResponse,
  type CortesPago
} from "@/types/comisiones";

// La lista del mes tiene que mostrar un solo estado por pago, todas las filas por
// defecto y los totales con su monto: lo que no puede perderse en un cambio de estilo.

function pago(id: string, ini: string, fin: string, estado: CortesEstado, dif: number | null, extra: Partial<CortesPago> = {}): CortesPago {
  return {
    pago_id: id,
    docs: [id],
    ini,
    fin,
    ini_default: ini,
    fin_default: fin,
    pagado: 10_000,
    calculado: dif === null ? null : 10_000 + dif,
    diferencia: dif,
    estado,
    sin_calculo: false,
    drift: null,
    ajustado: false,
    sugerencia: null,
    ...extra
  };
}

function fila(id: string, nombre: string | null, pagos: CortesPago[], extra: Partial<CortesFila> = {}): CortesFila {
  return {
    fila_id: `DBC|${id}|H`,
    sociedad: "DBC",
    comisionista_id: id,
    comisionista: nombre,
    division_code: "H",
    pagos,
    huecos: [],
    traslapes: [],
    cortes: [],
    ...extra
  };
}

const RESPUESTA: CortesMesResponse = {
  mes: "2026-07",
  desde: "2026-07-01",
  hasta: "2026-07-31",
  cobertura: { desde: "2026-01-02", hasta: "2026-10-06" },
  filas: [
    fila("0000001450", "EDGARDO TRUJILLO", [
      pago("a", "2026-06-27", "2026-07-03", "sug", 4100),
      pago("b", "2026-07-04", "2026-07-10", "ok", 0)
    ]),
    fila("0000004335", "NOEL GARCIA", [pago("c", "2026-07-04", "2026-07-10", "ok", 0)]),
    fila(
      "0000014917",
      null,
      [pago("d", "2026-07-04", "2026-07-10", "sin", -2500), pago("e", "2026-07-11", "2026-07-17", "sinv", null, { ini: null, fin: null })],
      { huecos: [{ ini: "2026-07-18", fin: "2026-07-20", comision: 1800, despues_de: "d", antes_de: "f" }] }
    )
  ]
};

function pinta(respuesta: CortesMesResponse | null = RESPUESTA, error: string | null = null) {
  return renderToStaticMarkup(
    <CortesWorkspace
      initialCatalog={EMPTY_CATALOG}
      initialError={error}
      initialResponse={respuesta}
      mesInicial="2026-07"
      meses={["2026-07", "2026-06"]}
    />
  );
}

describe("CortesWorkspace", () => {
  it("el título deja claro que compara lo calculado con lo pagado", () => {
    expect(pinta()).toContain("Comisión calculada frente a comisión pagada");
  });

  it("por defecto se ven todas las filas, incluso las que ya cuadran", () => {
    const html = pinta();
    expect(html).toContain("EDGARDO TRUJILLO");
    expect(html).toContain("NOEL GARCIA");
    expect(html).toContain("todo cuadra");
    expect(html).not.toContain("ocultos porque todo cuadra");
  });

  it("cada pago muestra su estado y su diferencia, y las semanas del mes son las columnas", () => {
    const html = pinta();
    expect(html).toContain("27 jun a 3 jul");
    expect(html).toContain("25 jul a 31 jul");
    expect(html).toContain("Sugerencia");
    expect(html).toContain("+$4,100");
    expect(html).toContain("-$2,500");
  });

  it("la cabecera cuenta los pagos por estado con su monto en pesos", () => {
    const html = pinta();
    expect(html).toContain("Cuadran");
    expect(html).toContain("Con sugerencia");
    expect(html).toContain("Dif. $4,100");
    expect(html).toContain("$20,000 calculado");
    expect(html).toContain("Cobros sin pago");
    expect(html).toContain("$1,800 de comisión");
  });

  it("un comisionista sin nombre se muestra por su número, no vacío", () => {
    expect(pinta()).toContain("Proveedor 14917");
  });

  it("aparece la columna de pagos sin ventana solo cuando hay alguno", () => {
    expect(pinta()).toContain("<span>Sin ventana</span></div>");
    const sin = { ...RESPUESTA, filas: RESPUESTA.filas.slice(0, 2) };
    expect(pinta(sin)).not.toContain("<span>Sin ventana</span></div>");
  });

  it("sin pagos en el mes lo dice, y un error del servicio se muestra", () => {
    expect(pinta({ ...RESPUESTA, filas: [] })).toContain("Sin pagos en este mes.");
    expect(pinta(null, "No se pudo cargar")).toContain("No se pudo cargar");
  });
});
