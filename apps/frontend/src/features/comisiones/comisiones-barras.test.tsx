import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { abreviar, BarrasVerticales, techoBonito, type BarraVertical } from "@/features/comisiones/comisiones-barras";

const MESES: BarraVertical[] = [
  { valor: "2026-01", etiqueta: "ene", cantidad: 120_000 },
  { valor: "2026-02", etiqueta: "feb", cantidad: 90_000 },
  { valor: "2026-03", etiqueta: "mar", cantidad: 150_000 }
];

function svg(props: Partial<Parameters<typeof BarrasVerticales>[0]> = {}) {
  return renderToStaticMarkup(<BarrasVerticales color="#3d3d7c" datos={MESES} {...props} />);
}

describe("el formato abreviado del eje", () => {
  it("escribe el cero como «$0», sin decimal colgando", () => {
    // ESTE es el caso que rompió la pantalla en el contenedor: con `Intl` y
    // `notation: "compact"`, el Node de allí escribía "$0.0" y Chrome "$0".
    // Texto distinto en servidor y en cliente = fallo de hidratación, y React
    // tira el HTML del servidor y remonta la rama entera.
    expect(abreviar(0)).toBe("$0");
  });

  it("no depende de la versión de ICU, así que sirve para hidratar", () => {
    // Nada de `Intl` aquí: `toString()` de un número está definido por el
    // lenguaje, no por los datos de locale, así que el servidor y el navegador
    // escriben lo mismo aunque traigan ICU distintas.
    expect(abreviar(500)).toBe("$500");
    expect(abreviar(12_000)).toBe("$12 k");
    expect(abreviar(2_500_000)).toBe("$2.5 M");
    expect(abreviar(732_533_406)).toBe("$732.5 M");
  });

  it("aguanta los negativos sin inventarse el signo", () => {
    expect(abreviar(-2_500_000)).toBe("$-2.5 M");
  });
});

describe("el techo del eje", () => {
  it("redondea a una cifra que alguien pueda leer", () => {
    expect(techoBonito(150_000)).toBe(200_000);
    expect(techoBonito(900_000)).toBe(1_000_000);
    expect(techoBonito(18_260_942)).toBe(20_000_000);
    expect(techoBonito(2_100_000)).toBe(2_500_000);
  });

  it("nunca devuelve cero, ni con una serie a cero", () => {
    // Un techo de cero sería una división por cero en la escala.
    expect(techoBonito(0)).toBe(1);
    expect(techoBonito(-5)).toBe(1);
  });
});

describe("las barras", () => {
  it("arrancan el eje en cero", () => {
    // Cortado por abajo, un mes un 10% peor parecería la mitad — y de esta
    // gráfica sale una provisión.
    expect(svg()).toMatch(/\$0/);
  });

  it("dibuja una barra por dato, con su rótulo y su cifra", () => {
    const html = svg();
    expect(html.match(/comisiones-grafica-barra/g)).toHaveLength(3);
    expect(html).toMatch(/>ene</);
    expect(html).toMatch(/\$120 k/);
  });

  it("no promete un clic si no hay a dónde ir", () => {
    // Sin `onSelect` no hay filtro detrás: la barra no se marca como pulsable.
    expect(svg()).not.toMatch(/data-pulsable/);
    expect(svg({ onSelect: () => undefined })).toMatch(/data-pulsable="si"/);
  });

  it("no hace pulsable el grupo sin asignar, que no es una categoría", () => {
    const html = svg({
      datos: [{ valor: null, etiqueta: "Sin CEDIS", cantidad: 12_000, color: "#9a948c" }],
      onSelect: () => undefined
    });
    expect(html).not.toMatch(/data-pulsable/);
    expect(html).toMatch(/#9a948c/);
  });

  it("no pierde una barra cuando dos rótulos recortados salen iguales", () => {
    // La clave era la `etiqueta`, y la etiqueta va recortada: dos CEDIS que
    // empiezan igual colapsaban en la misma clave y React puede OMITIR uno.
    // El síntoma no es un aviso, es una barra que falta. Ahora la clave es el
    // `valor`, que es el código y sí es único.
    const html = svg({
      datos: [
        { valor: "Mexico Carlos de Anda", etiqueta: "Mexico Carlos…", cantidad: 500 },
        { valor: "Mexico Carlos de Anda 2", etiqueta: "Mexico Carlos…", cantidad: 300 }
      ]
    });
    expect(html.match(/comisiones-grafica-barra/g)).toHaveLength(2);
  });

  it("da el nombre entero en el tooltip cuando el rótulo va recortado", () => {
    const html = svg({
      datos: [
        {
          valor: "Mexico Carlos de Anda",
          etiqueta: "Mexico Carlos…",
          nombre: "Mexico Carlos de Anda",
          cantidad: 500
        }
      ]
    });
    expect(html).toMatch(/<title>Mexico Carlos de Anda:/);
  });

  it("separa del eje los rótulos girados, y para eso crece la caja", () => {
    // Pegados al eje los nombres de CEDIS se mezclan con el pie de las barras.
    // Bajarlos dentro de la misma caja habría recortado la barra, así que la
    // variante girada es más alta — usa el hueco que sobraba en la tarjeta.
    const recto = svg();
    const girado = svg({ rotulosGirados: true });

    const altoDe = (html: string) => Number(html.match(/height="(\d+)"/)?.[1]);
    expect(altoDe(girado)).toBeGreaterThan(altoDe(recto));

    // El rótulo girado queda más abajo respecto a la línea del cero que el recto.
    const yDe = (html: string) => Number(html.match(/comisiones-grafica-rotulo[^>]*y="([\d.]+)"/)?.[1]);
    const ceroDe = (html: string) => Number(html.match(/comisiones-grafica-linea[^>]*y1="([\d.]+)"/)?.[1]);
    expect(yDe(girado) - ceroDe(girado)).toBeGreaterThan(yDe(recto) - ceroDe(recto));

    // Y queda sitio DEBAJO del anclaje para que el texto girado descienda sin
    // salirse de la caja: es lo que se rompe si alguien baja más los rótulos
    // sin tocar la altura, y no da error — solo recorta los nombres.
    expect(altoDe(girado) - yDe(girado)).toBeGreaterThanOrEqual(40);
  });

  it("dibuja algo aunque el contenedor todavía mida cero", () => {
    // En servidor no hay ResizeObserver: sin un ancho mínimo, el HTML de
    // partida saldría sin barras y la gráfica aparecería de golpe al hidratar.
    expect(svg()).toMatch(/<rect/);
  });

  it("dice qué hacer cuando no hay nada que dibujar", () => {
    expect(renderToStaticMarkup(<BarrasVerticales color="#3d3d7c" datos={[]} vacio="Sin comisión" />)).toMatch(
      /Sin comisión/
    );
  });
});
