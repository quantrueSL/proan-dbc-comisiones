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
  por_cedis: [
    {
      cedis: "Leon 1",
      num_lineas: 80,
      monto: 8_000_000,
      comision: 900_000,
      comision_con_cobro: 0,
      monto_calculable: 8_000_000
    },
    {
      cedis: null,
      num_lineas: 3,
      monto: 1_300_000,
      comision: 12_000,
      comision_con_cobro: 0,
      monto_calculable: 0
    }
  ],
  // Los cinco tipos que existen de verdad, más el grupo sin tipo: es el caso que
  // rompía el donut, porque la paleta solo tenía cuatro colores.
  por_tipo_venta: [
    "VTA EN RUTA",
    "MED MAYOREO",
    "MAYOREO",
    "VTA EN PISO",
    "EXTRAS",
    null
  ].map((tipo_venta, indice) => ({
    tipo_venta,
    num_lineas: 10,
    monto: 1_000_000,
    comision: 900_000 - indice * 100_000,
    comision_con_cobro: 0,
    monto_calculable: 1_000_000
  })),
  por_fecha: [
    {
      fecha: "2026-01-05",
      num_lineas: 10,
      monto: 1_000_000,
      comision: 120_000,
      comision_con_cobro: 0,
      monto_calculable: 1_000_000
    },
    {
      fecha: "2026-02-05",
      num_lineas: 10,
      monto: 1_000_000,
      comision: 90_000,
      comision_con_cobro: 0,
      monto_calculable: 1_000_000
    }
  ],
  // Hojas del desglose: el grano de la tarifa. De aquí salen las dos cascadas.
  desglose: [
    {
      sociedad: "DBC",
      comisionista: "ELIAS BARBA",
      division_code: "H",
      division: "Huevo",
      cedis: "Leon 1",
      oficina: "0016",
      set: "HSANJUAN",
      tipo_venta: "VTA EN RUTA",
      base_unidad: "kg",
      cantidad_base: 400_000,
      num_lineas: 60,
      monto: 6_000_000,
      comision: 700_000,
      comision_con_cobro: 200_000,
      monto_calculable: 6_000_000
    },
    {
      sociedad: "DBC",
      comisionista: "ELIAS BARBA",
      division_code: "BO",
      division: "Botana",
      cedis: "Leon 1",
      oficina: "0016",
      set: "BOVUALA",
      tipo_venta: "MAYOREO",
      base_unidad: "caja",
      cantidad_base: 9_000,
      num_lineas: 40,
      monto: 4_000_000,
      comision: 459_105,
      comision_con_cobro: 100_000,
      monto_calculable: 2_000_000
    },
    {
      sociedad: "DBC",
      comisionista: "JAIME ROJAS",
      division_code: "H",
      division: "Huevo",
      cedis: "Queretaro",
      oficina: "0021",
      set: "HPORTALES",
      tipo_venta: "VTA EN RUTA",
      base_unidad: "kg",
      cantidad_base: 150_000,
      num_lineas: 20,
      monto: 2_000_000,
      comision: 250_000,
      comision_con_cobro: 0,
      monto_calculable: 2_000_000
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
  it("va plegado y al final, pero con su importe en el rótulo", () => {
    // Se pliega el DESGLOSE POR MOTIVO, no el hecho de que falte dinero: cerrado
    // sigue diciendo cuánto es, así que "¿esto está completo?" se contesta sin
    // pulsar nada. Si el importe se va del rótulo, el desplegable pasa a
    // esconder justo lo que no se puede esconder.
    const html = pantalla();
    expect(html).toMatch(/<details class="comisiones-plegable">/);
    expect(html).not.toMatch(/<details class="comisiones-plegable" open/);

    const resumen = html.match(/<summary>[\s\S]*?<\/summary>/)?.[0] ?? "";
    expect(resumen).toMatch(/Lo que todavía no entra en el cálculo/);
    expect(resumen).toMatch(/\$193,396,122 facturados sin comisión aplicable/);

    // Al final: después de las dos tablas de detalle.
    expect(html.indexOf("comisiones-plegable")).toBeGreaterThan(html.indexOf("Comisión por división"));
  });

  it("mantiene el desglose por motivo dentro del desplegable", () => {
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

describe("el detalle de una fila bloqueada", () => {
  // El clic abre un modal (estado de cliente): con renderToStaticMarkup no se
  // puede simular, así que aquí solo se fija el marcado estático -- que la
  // fila correcta quede lista para recibir el clic y ninguna otra.
  const CON_DETALLE: ReportResponse = {
    ...INFORME,
    bloqueado: [
      ...INFORME.bloqueado,
      { motivo: "sin tarifa para esa llave", num_lineas: 1_282, monto: 61_083_000, comision_min: 0, comision_max: 0 }
    ],
    bloqueado_desglose: [
      {
        motivo: "sin tarifa para esa llave",
        sociedad: "PAN",
        division_code: "H",
        division: "Huevo",
        oficina: "0028",
        set: "HPORTALES",
        tipo_venta: "VTA EN RUTA",
        num_lineas: 210,
        monto: 47_607_643
      }
    ]
  };

  it("solo la fila de \"sin tarifa para esa llave\" queda marcada como clicable", () => {
    const html = pantalla(CON_DETALLE);
    expect(html).toMatch(/<tr class="comisiones-bloqueado-clicable"[^>]*>\s*<td>\s*sin tarifa para esa llave/);
    // Las otras dos filas del bloqueado NO llevan la clase.
    expect(html).not.toMatch(/<tr class="comisiones-bloqueado-clicable"[^>]*>\s*<td>\s*(tarifa en conflicto entre hojas|material sin SET)/);
  });

  it("no se abre solo, aunque haya desglose disponible", () => {
    // El modal depende de estado de cliente (`motivoDetalle`), que arranca en
    // `null`: la carga inicial nunca debe traer el modal ya abierto.
    expect(pantalla(CON_DETALLE)).not.toMatch(/Sociedad<\/th>/);
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

describe("la cabecera", () => {
  it("enseña la comisión devengada como titular", () => {
    expect(texto()).toMatch(/Comisión devengada \$18,260,942/);
  });

  it("cuenta comisionistas a pagar, y no las líneas calculadas", () => {
    // Cuatro indicadores en fila repetían tres pasos del embudo y remataban con
    // un conteo de líneas, que no contesta a ninguna pregunta.
    const t = texto();
    expect(t).toMatch(/1 comisionistas/);
    expect(t).not.toMatch(/Líneas calculadas/);
  });
});

describe("el embudo", () => {
  it("enseña los cuatro pasos del cálculo", () => {
    const t = texto();
    for (const paso of [
      "Facturado en alcance",
      "Con tarifa aplicable",
      "Comisión devengada",
      "Con cobro registrado"
    ]) {
      expect(t).toMatch(paso);
    }
  });

  it("avisa de que las dos mitades no comparten escala", () => {
    // Los pasos de comisión valen un 2-3% de los de facturación: con una escala
    // única sus barras serían dos rayas y el embudo diría "aquí no queda nada".
    expect(texto()).toMatch(/Cada mitad se dibuja a su propia escala/);
  });

  it("marca el salto de facturado a comisión con una palabra, no con un porcentaje", () => {
    // Ese número sería la tasa efectiva, y no es comparable entre periodos:
    // cambia con la mezcla de divisiones (huevo va por kilo, abarrotes por
    // margen). Así que de las tres flechas, solo dos llevan porcentaje.
    const flechas = pantalla().match(/comisiones-embudo-flecha[\s\S]*?<\/div>/g) ?? [];
    expect(flechas).toHaveLength(3);
    expect(flechas.filter((f) => f.includes("%"))).toHaveLength(2);
    expect(flechas[1]).toMatch(/genera/);
  });
});

describe("el tablero", () => {
  it("pinta la comisión por CEDIS, por mes y por tipo de venta", () => {
    const t = texto();
    expect(t).toMatch(/Comisión por CEDIS/);
    expect(t).toMatch(/Leon 1/);
    expect(t).toMatch(/Comisión por mes/);
    expect(t).toMatch(/Por tipo de venta/);
    expect(t).toMatch(/VTA EN RUTA/);
  });

  it("dibuja CEDIS y mes como gráficas de barras, no como listas", () => {
    // Se hicieron primero con `RankedBars`, que es rótulo + barra + cifra en
    // columna: una tabla con una barra dentro. Para una serie de meses eso tapa
    // justo lo que hay que ver, que es la tendencia.
    const html = pantalla();
    const graficas = html.match(/class="comisiones-grafica"/g) ?? [];
    expect(graficas).toHaveLength(2);
    expect(html).not.toMatch(/dashboard-bar-list/);
  });

  it("no repite el año en cada barra cuando la serie no cruza de año", () => {
    // Ocho barras diciendo "2026" no informan y el rótulo deja de caber.
    const t = texto();
    expect(t).toMatch(/ene/);
    expect(t).not.toMatch(/ene 2026/);
  });

  it("no llama CEDIS al grupo que no tiene CEDIS", () => {
    expect(texto()).toMatch(/Sin CEDIS asignado/);
  });

  it("etiqueta el mes sin que el huso horario le reste un día", () => {
    // `new Date("2026-01-05")` es UTC y en México cae en el mes anterior: el
    // primer mes de la serie saldría como diciembre.
    const t = texto();
    expect(t).toMatch(/ene/);
    // Con frontera de palabra: sin ella, cualquier "dice" o "indicador" del
    // texto de la pantalla haría fallar este test sin que hubiera nada roto.
    expect(t).not.toMatch(/dic/);
  });

  it("no repite color entre tipos de venta", () => {
    // La paleta tenía cuatro colores y hay cinco tipos, así que VTA EN RUTA y
    // EXTRAS salían del mismo azul: dos entradas de la leyenda con el mismo tono
    // y nada que las distinga salvo leer el texto.
    const html = pantalla();
    const dots = html.match(/dashboard-status-dot[^>]*background:\s*([^;"]+)/g) ?? [];
    expect(dots).toHaveLength(6);
    const colores = dots.map((d) => d.split("background:")[1].trim().toLowerCase());
    expect(new Set(colores).size).toBe(6);
  });

  it("no ofrece pulsar el tipo de venta, porque no hay ese filtro", () => {
    // El endpoint de comisión filtra por división, CEDIS y comisionista. Un
    // botón de tipo de venta se pulsaría y no pasaría nada.
    const html = pantalla();
    expect(html).not.toMatch(/Filtrar por VTA EN RUTA/);
  });
});

describe("las dos tablas de detalle", () => {
  it("siguen abajo, debajo de los estadísticos generales", () => {
    // El embudo y las gráficas resumen; estas dos son el detalle del que se
    // paga y no pueden quedarse fuera al reordenar la pantalla.
    const html = pantalla();
    const embudo = html.indexOf("comisiones-embudo");
    const porComisionista = html.indexOf("Comisión por comisionista");
    const porDivision = html.indexOf("Comisión por división");

    expect(porComisionista).toBeGreaterThan(embudo);
    expect(porDivision).toBeGreaterThan(porComisionista);
    expect(texto()).toMatch(/ELIAS BARBA/);
    expect(texto()).toMatch(/Huevo/);
  });

  it("lleva la jerarquía escrita en cada título", () => {
    const t = texto();
    expect(t).toMatch(/Comisión por comisionista \(Comisionista → División → SET\)/);
    expect(t).toMatch(/Comisión por división \(División → CEDIS → Comisionista → SET\)/);
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
