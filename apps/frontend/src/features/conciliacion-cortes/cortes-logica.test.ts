import { describe, expect, it } from "vitest";
import type { CortesEstado, CortesFila, CortesPago, CortesSugerencia } from "@/types/comisiones";
import {
  agruparPorComisionista,
  calculadoPorParte,
  colaDePagos,
  cortesMovidos,
  describirMovimiento,
  diasQueCambian,
  elementosDeLinea,
  esPendiente,
  fechaConDia,
  filaTodoCuadra,
  filtrarFilas,
  hayDrift,
  huecosDelMes,
  limitesDeCorte,
  moverCorteLocal,
  mesPorDefecto,
  mesesDisponibles,
  nombreComisionista,
  pagosEnVista,
  posicionarPagos,
  rangoCorto,
  resumenLote,
  semanasDelMes,
  siguientePendiente,
  textoDiferencia,
  totalesCortes,
  totalesPorColumna
} from "./cortes-logica";

function pago(id: string, ini: string | null, fin: string | null, estado: CortesEstado = "ok", extra: Partial<CortesPago> = {}): CortesPago {
  return {
    pago_id: id,
    docs: [id],
    ini,
    fin,
    ini_default: ini,
    fin_default: fin,
    pagado: 1000,
    calculado: 1000,
    diferencia: 0,
    estado,
    sin_calculo: false,
    drift: null,
    descartada: false,
    ajustado: false,
    sugerencia: null,
    ...extra
  };
}

function fila(id: string, pagos: CortesPago[], extra: Partial<CortesFila> = {}): CortesFila {
  return {
    fila_id: id,
    sociedad: "DBC",
    comisionista_id: `000${id}`,
    comisionista: `Comisionista ${id}`,
    division_code: "H",
    version: 0,
    pagos,
    huecos: [],
    traslapes: [],
    cortes: [],
    ...extra
  };
}

describe("fechas", () => {
  it("formatea sin perder un día por la zona horaria", () => {
    expect(fechaConDia("2026-07-03")).toBe("vie 3 jul");
    expect(rangoCorto("2026-06-27", "2026-07-03")).toBe("27 jun a 3 jul");
  });

  it("textoDiferencia: $0 dentro de ±$1, signo explícito fuera, raya si no hay", () => {
    expect(textoDiferencia(0.4)).toBe("$0");
    expect(textoDiferencia(-4100)).toBe("-$4,100");
    expect(textoDiferencia(4100)).toBe("+$4,100");
    expect(textoDiferencia(null)).toBe("—");
  });
});

describe("meses", () => {
  it("las semanas de julio 2026 van de sábado a viernes y arrancan el 27 de junio", () => {
    const s = semanasDelMes("2026-07");
    expect(s[0]).toEqual({ ini: "2026-06-27", fin: "2026-07-03" });
    expect(s).toHaveLength(5);
    expect(s[4]).toEqual({ ini: "2026-07-25", fin: "2026-07-31" });
  });

  it("un mes que arranca en sábado no trae semana de más", () => {
    const s = semanasDelMes("2026-08"); // 1 ago 2026 es sábado
    expect(s[0].ini).toBe("2026-08-01");
    expect(s[s.length - 1].fin >= "2026-08-31").toBe(true);
  });

  it("mes por defecto: el de hace dos semanas; lista de meses descendente", () => {
    expect(mesPorDefecto("2026-10-14")).toBe("2026-09");
    expect(mesPorDefecto("2026-10-20")).toBe("2026-10");
    expect(mesesDisponibles("2026-01-02", "2026-03-10")).toEqual(["2026-03", "2026-02", "2026-01"]);
  });
});

describe("posicionarPagos", () => {
  const semanas = semanasDelMes("2026-07");

  it("un pago por semana ocupa una columna cada uno", () => {
    const pagos = [
      pago("a", "2026-06-27", "2026-07-03"),
      pago("b", "2026-07-04", "2026-07-10"),
      pago("c", "2026-07-11", "2026-07-17")
    ];
    expect(posicionarPagos(pagos, semanas).map((p) => [p.colIni, p.colFin])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("un pago acumulado ocupa varias columnas", () => {
    const pagos = [pago("a", "2026-06-27", "2026-07-03"), pago("b", "2026-07-04", "2026-07-17"), pago("c", "2026-07-18", "2026-07-24")];
    expect(posicionarPagos(pagos, semanas).map((p) => [p.colIni, p.colFin])).toEqual([[0, 0], [1, 2], [3, 3]]);
  });

  it("con cortes desfasados un día los pagos no se montan", () => {
    const pagos = [pago("a", "2026-06-27", "2026-07-02"), pago("b", "2026-07-03", "2026-07-09"), pago("c", "2026-07-10", "2026-07-16")];
    expect(posicionarPagos(pagos, semanas).map((p) => [p.colIni, p.colFin])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("el primer pago empieza en la semana de su inicio, no en la primera columna", () => {
    const pagos = [pago("b", "2026-07-04", "2026-07-10")];
    expect(posicionarPagos(pagos, semanas)).toMatchObject([{ colIni: 1, colFin: 1 }]);
  });

  it("los pagos sin ventana no se posicionan", () => {
    expect(posicionarPagos([pago("x", null, null, "sinv")], semanas)).toEqual([]);
  });
});

describe("filtros y totales", () => {
  const a = fila("1", [pago("a1", "2026-07-04", "2026-07-10", "ok")]);
  const b = fila("2", [pago("b1", "2026-07-04", "2026-07-10", "sug", { diferencia: -400, calculado: 600 })], { division_code: "BO" });
  const c = fila("3", [pago("c1", "2026-07-04", "2026-07-10", "cons")]);

  it("todo cuadra = cuadra o consolidado", () => {
    expect(filaTodoCuadra(a)).toBe(true);
    expect(filaTodoCuadra(c)).toBe(true);
    expect(filaTodoCuadra(b)).toBe(false);
  });

  it("por defecto se ven todas las filas; 'solo acción' oculta las que cuadran salvo la seleccionada", () => {
    const todas = { division: "", comisionistaId: "", soloAccion: false };
    expect(filtrarFilas([a, b, c], todas)).toHaveLength(3);
    const accion = { ...todas, soloAccion: true };
    expect(filtrarFilas([a, b, c], accion).map((f) => f.fila_id)).toEqual(["2"]);
    expect(filtrarFilas([a, b, c], accion, "1").map((f) => f.fila_id)).toEqual(["1", "2"]);
  });

  it("filtra por división y por comisionista", () => {
    expect(filtrarFilas([a, b, c], { division: "BO", comisionistaId: "", soloAccion: false }).map((f) => f.fila_id)).toEqual(["2"]);
    expect(filtrarFilas([a, b, c], { division: "", comisionistaId: "0003", soloAccion: false }).map((f) => f.fila_id)).toEqual(["3"]);
  });

  it("totales por estado con calculado y diferencia absoluta, y cobros sin pago dentro del mes", () => {
    const conHueco = fila("4", [pago("d1", "2026-07-04", "2026-07-10", "sin", { diferencia: 250, calculado: 1250 })], {
      huecos: [
        { ini: "2026-07-11", fin: "2026-07-13", comision: 900, despues_de: "d1", antes_de: "d2", cierre: false },
        { ini: "2026-09-01", fin: "2026-09-03", comision: 700, despues_de: "x", antes_de: "y", cierre: false },
        { ini: "2026-07-20", fin: "2026-07-21", comision: 0, despues_de: "x", antes_de: "y", cierre: false }
      ]
    });
    const t = totalesCortes([a, b, c, conHueco], "2026-07-01", "2026-07-31");
    expect(t.porEstado.ok.n).toBe(1);
    expect(t.porEstado.sug).toMatchObject({ n: 1, calculado: 600, difAbs: 400 });
    expect(t.porEstado.sin).toMatchObject({ n: 1, difAbs: 250 });
    expect(t.totalPagos).toBe(4);
    expect(t.sinPago).toEqual({ n: 1, comision: 900 });
    expect(t.cierre).toEqual({ n: 0, comision: 0 });
    expect(huecosDelMes(conHueco, "2026-07-01", "2026-07-31")).toEqual({ n: 1, comision: 900 });
  });

  it("el último día del mes no cuenta como cobro sin pago: se suma aparte como cierre de mes", () => {
    const f = fila("5", [pago("e1", "2026-07-04", "2026-07-10", "ok")], {
      huecos: [
        { ini: "2026-07-31", fin: "2026-07-31", comision: 500, despues_de: "e1", antes_de: "e2", cierre: true },
        { ini: "2026-07-18", fin: "2026-07-19", comision: 300, despues_de: "e1", antes_de: "e2", cierre: false }
      ]
    });
    const t = totalesCortes([f], "2026-07-01", "2026-07-31");
    expect(t.sinPago).toEqual({ n: 1, comision: 300 });
    expect(t.cierre).toEqual({ n: 1, comision: 500 });
    expect(huecosDelMes(f, "2026-07-01", "2026-07-31")).toEqual({ n: 1, comision: 300 });
  });

  it("nombre: el del proveedor o su número sin ceros", () => {
    expect(nombreComisionista({ comisionista: "  ROSA MEDINA ", comisionista_id: "0000001450" })).toBe("ROSA MEDINA");
    expect(nombreComisionista({ comisionista: null, comisionista_id: "0000014917" })).toBe("Proveedor 14917");
  });
});

describe("línea de tiempo", () => {
  const p1 = pago("p1", "2026-06-27", "2026-07-03");
  const p2 = pago("p2", "2026-07-04", "2026-07-10");
  const p3 = pago("p3", "2026-07-14", "2026-07-17");
  const p4 = pago("p4", "2026-07-16", "2026-07-24");
  const f = fila("1", [p3, p1, p4, p2], {
    cortes: [{ izq: "p1", der: "p2", fecha: "2026-07-03", congelado: true }],
    huecos: [{ ini: "2026-07-11", fin: "2026-07-13", comision: 800, despues_de: "p2", antes_de: "p3", cierre: false }],
    traslapes: [{ ini: "2026-07-16", fin: "2026-07-17", pagos: ["p3", "p4"] }]
  });

  it("el pago y sus vecinos, según el contexto", () => {
    expect(pagosEnVista(f, "p2", 1).map((p) => p.pago_id)).toEqual(["p1", "p2", "p3"]);
    expect(pagosEnVista(f, "p2", 2).map((p) => p.pago_id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(pagosEnVista(f, "p1", 1).map((p) => p.pago_id)).toEqual(["p1", "p2"]);
    expect(pagosEnVista(f, "no-existe", 1)).toEqual([]);
  });

  it("entre pagos aparece un corte, un hueco o un traslape", () => {
    const el = elementosDeLinea(f, pagosEnVista(f, "p2", 2));
    expect(el.map((e) => e.tipo)).toEqual(["pago", "corte", "pago", "hueco", "pago", "traslape", "pago"]);
    expect(el[1]).toMatchObject({ tipo: "corte", fecha: "2026-07-03", congelado: true });
    expect(el[3]).toMatchObject({ tipo: "hueco", comision: 800 });
  });

  const sugerencia: CortesSugerencia = {
    tipo: "borde",
    pago_id: "p1",
    unica: true,
    n_opciones: 1,
    cambios: [
      { pago_id: "p1", borde: "fin", de: "2026-07-03", a: "2026-07-02" },
      { pago_id: "p2", borde: "ini", de: "2026-07-04", a: "2026-07-03" }
    ],
    afectados: []
  };

  it("el corte compartido se cuenta una vez y los días que cambian son los del medio", () => {
    expect(cortesMovidos(sugerencia)).toEqual([{ tipo: "corte", antes: "2026-07-03", despues: "2026-07-02" }]);
    expect([...diasQueCambian(sugerencia)]).toEqual(["2026-07-03"]);
  });

  it("un corte que se mueve hacia adelante marca los días que entran al pago", () => {
    const s: CortesSugerencia = {
      ...sugerencia,
      cambios: [
        { pago_id: "p1", borde: "fin", de: "2026-07-03", a: "2026-07-05" },
        { pago_id: "p2", borde: "ini", de: "2026-07-04", a: "2026-07-06" }
      ]
    };
    expect([...diasQueCambian(s)].sort()).toEqual(["2026-07-04", "2026-07-05"]);
    expect(cortesMovidos(s)).toEqual([{ tipo: "corte", antes: "2026-07-03", despues: "2026-07-05" }]);
  });

  it("un borde suelto (sin corte compartido) se describe como terminar o empezar el pago", () => {
    const suelta: CortesSugerencia = {
      ...sugerencia,
      cambios: [{ pago_id: "p1", borde: "fin", de: "2026-07-03", a: "2026-07-02" }]
    };
    const [m] = cortesMovidos(suelta);
    expect(m.tipo).toBe("fin");
    expect(describirMovimiento(m)).toBe("terminar el pago el jue 2 jul en vez del vie 3 jul");
    const inicio = cortesMovidos({ ...suelta, cambios: [{ pago_id: "p1", borde: "ini", de: "2026-07-04", a: "2026-07-06" }] });
    expect(describirMovimiento(inicio[0])).toBe("empezar el pago el lun 6 jul en vez del sáb 4 jul");
    expect(describirMovimiento({ tipo: "corte", antes: "2026-07-03", despues: "2026-07-02" })).toBe(
      "mover el corte del vie 3 jul al jue 2 jul"
    );
  });

  it("sin sugerencia no hay días marcados", () => {
    expect(diasQueCambian(null).size).toBe(0);
  });
});

describe("mover un corte en la vista previa", () => {
  const a = pago("a", "2026-07-04", "2026-07-10", "sin", { pagado: 1000, calculado: 1400, diferencia: 400 });
  const b = pago("b", "2026-07-11", "2026-07-17", "sin", { pagado: 2000, calculado: 1600, diferencia: -400 });
  const f = fila("1", [a, b], { cortes: [{ izq: "a", der: "b", fecha: "2026-07-10", congelado: false }] });
  // el sábado 11 y el domingo 12 valen 200 y 200; el resto de los días no importa aquí
  const dias = new Map<string, number>([
    ["2026-07-10", 400],
    ["2026-07-11", 400]
  ]);
  for (let d = 4; d <= 9; d++) dias.set(`2026-07-${String(d).padStart(2, "0")}`, 1000 / 6);
  for (let d = 12; d <= 17; d++) dias.set(`2026-07-${d}`, 1600 / 6);

  it("recalcula los dos pagos y deja en cero el que cuadra", () => {
    // pasar el 10 al segundo pago: a = 4..9 = 1000, b = 10..17 = 400 + 400 + 1600 = 2400 (no cuadra)
    const v = moverCorteLocal(f, dias, "a", "2026-07-09");
    const va = v.pagos.find((p) => p.pago_id === "a")!;
    const vb = v.pagos.find((p) => p.pago_id === "b")!;
    expect(va.fin).toBe("2026-07-09");
    expect(va.estado).toBe("ok");
    expect(vb.ini).toBe("2026-07-10");
    expect(vb.diferencia).toBe(400);
    expect(vb.estado).toBe("sin");
    expect(v.cortes[0].fecha).toBe("2026-07-09");
    expect(va.ajustado).toBe(true);
  });

  it("no toca la fila original ni cortes que no existen", () => {
    moverCorteLocal(f, dias, "a", "2026-07-09");
    expect(f.pagos[0].fin).toBe("2026-07-10");
    expect(moverCorteLocal(f, dias, "zzz", "2026-07-09")).toBe(f);
  });

  it("límites: el pago de la izquierda conserva un día y el de la derecha también", () => {
    expect(limitesDeCorte(f, "a")).toEqual({ min: "2026-07-04", max: "2026-07-16" });
    expect(limitesDeCorte(f, "b")).toBeNull();
  });
});


describe("tabla por comisionista", () => {
  const semanas = semanasDelMes("2026-07"); // 27 jun a 3 jul, 4 a 10 jul, ...

  it("agrupa las filas de un mismo comisionista y conserva el orden", () => {
    const a1 = fila("1", [pago("a", "2026-07-04", "2026-07-10")]);
    const a2 = { ...fila("2", [pago("b", "2026-07-04", "2026-07-10")]), comisionista_id: a1.comisionista_id, comisionista: a1.comisionista };
    const otro = fila("3", [pago("c", "2026-07-04", "2026-07-10")]);
    const grupos = agruparPorComisionista([a1, a2, otro]);
    expect(grupos.map((g) => g.filas.length)).toEqual([2, 1]);
    expect(grupos[0].nombre).toBe("Comisionista 1");
  });

  it("un comisionista con filas en DBC y en PAN es un solo grupo", () => {
    const dbc = fila("1", [pago("a", "2026-07-04", "2026-07-10")]);
    const pan = { ...fila("2", [pago("b", "2026-07-04", "2026-07-10")]), sociedad: "PAN", comisionista_id: dbc.comisionista_id };
    const grupos = agruparPorComisionista([dbc, pan]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].filas.map((f) => f.sociedad)).toEqual(["DBC", "PAN"]);
  });

  it("el total de una columna suma pagado y calculado de sus divisiones; el pago acumulado cuenta donde termina", () => {
    const h = fila("1", [
      pago("a", "2026-06-27", "2026-07-10", "sin", { pagado: 3000, calculado: 2500, diferencia: -500 }),
      pago("b", "2026-07-11", "2026-07-17", "ok")
    ]);
    const l = fila("2", [pago("c", "2026-07-04", "2026-07-10", "ok", { pagado: 400, calculado: 400 })]);
    const t = totalesPorColumna([h, l], semanas);
    expect(t[0]).toEqual({ n: 0, pagado: 0, calculado: 0 });
    expect(t[1]).toEqual({ n: 2, pagado: 3400, calculado: 2900 });
    expect(t[2]).toEqual({ n: 1, pagado: 1000, calculado: 1000 });
    expect(t[semanas.length].n).toBe(0);
  });

  it("los pagos sin ventana suman su pagado en la última columna", () => {
    const f = fila("1", [pago("s", null, null, "sinv", { pagado: 700, calculado: null, diferencia: null })]);
    const t = totalesPorColumna([f], semanas);
    expect(t[semanas.length]).toEqual({ n: 1, pagado: 700, calculado: 0 });
  });

  it("pendiente es una sugerencia por revisar o un pago sin explicación", () => {
    expect(esPendiente(pago("a", "2026-07-04", "2026-07-10", "sug"))).toBe(true);
    expect(esPendiente(pago("a", "2026-07-04", "2026-07-10", "sin"))).toBe(true);
    expect(esPendiente(pago("a", "2026-07-04", "2026-07-10", "ok"))).toBe(false);
    expect(esPendiente(pago("a", "2026-07-04", "2026-07-10", "cons"))).toBe(false);
  });

  it("la cola recorre comisionista por comisionista y semana por semana, y el siguiente pendiente da la vuelta", () => {
    const f1 = fila("1", [pago("b", "2026-07-11", "2026-07-17", "ok"), pago("a", "2026-07-04", "2026-07-10", "sug")]);
    const f2 = fila("2", [pago("c", "2026-07-04", "2026-07-10", "sin")]);
    const cola = colaDePagos(agruparPorComisionista([f1, f2]), semanas);
    expect(cola.map((r) => r.pagoId)).toEqual(["a", "b", "c"]);
    const todos = [f1, f2];
    const pendiente = (r: { filaId: string; pagoId: string }) =>
      esPendiente(todos.find((f) => f.fila_id === r.filaId)!.pagos.find((p) => p.pago_id === r.pagoId)!);
    expect(siguientePendiente(cola, { filaId: "1", pagoId: "a" }, pendiente)?.pagoId).toBe("c");
    expect(siguientePendiente(cola, { filaId: "2", pagoId: "c" }, pendiente)?.pagoId).toBe("a");
    expect(siguientePendiente(cola, null, pendiente)?.pagoId).toBe("a");
    expect(siguientePendiente(cola, null, () => false)).toBeNull();
  });

  it("filtrar por Abarrotes deja pasar la fila de Huevo que se paga junto con Abarrotes", () => {
    const h = fila("1", [pago("a", "2026-07-04", "2026-07-10")], { junta_con: ["A"] });
    const bo = { ...fila("2", [pago("b", "2026-07-04", "2026-07-10")]), division_code: "BO" };
    const visibles = filtrarFilas([h, bo], { division: "A", comisionistaId: "", soloAccion: false });
    expect(visibles.map((f) => f.fila_id)).toEqual(["1"]);
  });

  it("el desglose por división suma cada origen dentro de la ventana del pago", () => {
    const partes: Record<string, [string, number][]> = {
      H: [["2026-07-03", 100], ["2026-07-04", 200], ["2026-07-10", 50], ["2026-07-11", 999]],
      A: [["2026-07-04", 10.555], ["2026-07-12", 7]]
    };
    expect(calculadoPorParte(partes, "2026-07-04", "2026-07-10")).toEqual({ H: 250, A: 10.56 });
    expect(calculadoPorParte(undefined, "2026-07-04", "2026-07-10")).toEqual({});
  });
});


describe("consolidar", () => {
  it("un consolidado avisa cuando cambió el calculado o el pago en SAP, y los demás estados no", () => {
    expect(hayDrift(pago("a", "2026-07-04", "2026-07-10", "cons", { drift: 0, drift_pagado: 0 }))).toBe(false);
    expect(hayDrift(pago("a", "2026-07-04", "2026-07-10", "cons", { drift: 250.5, drift_pagado: 0 }))).toBe(true);
    expect(hayDrift(pago("a", "2026-07-04", "2026-07-10", "cons", { drift: 0, drift_pagado: -80 }))).toBe(true);
    expect(hayDrift(pago("a", "2026-07-04", "2026-07-10", "cons", { drift: 0.5 }))).toBe(false);
    expect(hayDrift(pago("a", "2026-07-04", "2026-07-10", "ok", { drift: 900 }))).toBe(false);
  });

  it("el lote suma los pagos que el servidor consolidaría y cuenta las filas que tienen alguno", () => {
    const a = fila("1", [pago("a", "2026-07-04", "2026-07-10")], { lote: ["a", "b"] });
    const b = fila("2", [pago("c", "2026-07-04", "2026-07-10")], { lote: [] });
    const c = fila("3", [pago("d", "2026-07-04", "2026-07-10")]);
    expect(resumenLote([a, b, c])).toEqual({ pagos: 2, filas: 1 });
    expect(resumenLote([])).toEqual({ pagos: 0, filas: 0 });
  });
});
