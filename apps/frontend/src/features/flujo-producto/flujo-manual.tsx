// Manual de la pantalla de flujo de producto.
//
// No es un "acerca de": está escrito para que alguien que abre esto por primera
// vez entienda qué está viendo y, sobre todo, no saque conclusiones falsas. Las
// tres trampas de esta pantalla no se adivinan mirándola:
//   1. "Vendido" va semanas por detrás de las otras dos fases.
//   2. Dos tercios del importe no tienen CEDIS asignado.
//   3. Las cantidades no se pueden sumar entre unidades.
// Cada una tiene su apartado, con el porqué, qué hacer con ello y —desde el
// rediseño del manual— un juguete al lado que hace la cosa MAL a propósito para
// que se vea el tamaño del error. Los juguetes están en `manual-demos.tsx`.
//
// Sigue siendo un componente de SERVIDOR: el texto se escribe en el HTML y las
// demos son islas de cliente dentro. Lo que este manual dice es lo importante;
// las animaciones son el envoltorio.

import type { FlujoCobertura } from "@/types/comisiones";
import { COLOR_FASE } from "@/features/flujo-producto/fases";
import { DemoHueco, DemoSinAsignar, DemoUnidades } from "@/features/manual/manual-demos";

const FASES: { clave: string; titulo: string; texto: string }[] = [
  {
    clave: "vendido",
    titulo: "Vendido",
    texto:
      "Lo que el cliente pidió. Sale de los pedidos de venta de SAP. Es una intención de compra: todavía no se ha facturado ni cobrado nada, y el importe es orientativo."
  },
  {
    clave: "facturado",
    titulo: "Facturado",
    texto:
      "Lo que se facturó de verdad, con su importe fiable. Es la única fase que trae la cantidad convertida a cajas."
  },
  {
    clave: "cobrado",
    titulo: "Cobrado",
    texto:
      "El dinero efectivamente cobrado y compensado. Importa más que las otras dos, porque la comisión se paga sobre lo cobrado, no sobre lo vendido."
  }
];

export function FlujoManual({ cobertura }: { cobertura: FlujoCobertura }) {
  const hastaVendido = cobertura.vendido?.hasta;
  const hastaFacturado = cobertura.facturado?.hasta;

  return (
    <>
      <section className="manual-seccion" id="fases">
        <h2>Las tres líneas de la gráfica</h2>
        <p>
          Cada línea es una etapa del recorrido y son <b>momentos distintos de la misma venta</b>, así
          que sus importes no tienen por qué coincidir: entre lo que se pide, lo que se factura y lo
          que se acaba cobrando hay diferencias reales de negocio.
        </p>
        <ol className="flujo-manual-fases">
          {FASES.map((fase) => (
            <li key={fase.clave}>
              <i style={{ background: COLOR_FASE[fase.clave] }} aria-hidden="true" />
              <div>
                <b>{fase.titulo}</b>
                <span>{fase.texto}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="manual-nota">
          Falta una cuarta etapa, los <b>traspasos</b> (la entrada de producto al CEDIS). Está
          pendiente de que el cliente diga qué código de movimiento usa en su MB51.
        </p>
      </section>

      {/* `manual-doble`: el texto a un lado y el juguete al otro. En pantalla
          ancha se leen juntos —que es como se entienden— y en estrecha se
          apilan solos. */}
      <section className="manual-seccion" id="grafica">
        <h2>Cómo se lee la gráfica</h2>
        <div className="manual-doble">
          <div>
            <p>
              Cada día lleva tres barras juntas, una por etapa. Pasa el ratón por encima para ver las
              tres cifras de ese día, y usa los tres indicadores de arriba para elegir qué fase
              gobierna las barras de abajo. Si el periodo es largo, las barras pasan a agrupar por
              semana o por mes y la leyenda lo dice.
            </p>
            <p>
              <b>Si falta la barra de una fase, es que no hay dato de ese día, no que fuera cero.</b> Por
              eso no se dibuja nada en vez de dibujar una barra a ras del suelo: un cero diría que ese
              día no hubo movimiento, y sería mentira.
            </p>
          </div>
          <DemoHueco />
        </div>
      </section>

      <section className="manual-seccion" id="vendido">
        <h2>Por qué «Vendido» se queda atrás</h2>
        <p>
          La tabla de líneas de pedido de SAP dejó de recibir datos nuevos
          {hastaVendido ? (
            <>
              {" "}
              el <b>{hastaVendido}</b>
            </>
          ) : null}
          , mientras que facturado sigue llegando
          {hastaFacturado ? (
            <>
              {" "}
              hasta el <b>{hastaFacturado}</b>
            </>
          ) : null}
          . No es un fallo de esta herramienta ni de las consultas: es la ingesta de SAP, que es
          compartida con el resto del grupo. La cabecera del pedido sí llega al día; son las líneas
          las que no entran.
        </p>
        <p className="manual-nota">
          Mientras dure, no compares vendido con facturado en las fechas recientes: parecerá un
          desplome de ventas y solo es una laguna de datos. Para el cálculo de comisión importa menos
          de lo que parece, porque se paga sobre lo cobrado y esa etapa sí está al día.
        </p>
      </section>

      <section className="manual-seccion" id="sin-asignar">
        <h2>Qué es la fila «Sin asignar»</h2>
        <div className="manual-doble">
          <div>
            <p>
              Son las ventas cuya combinación de almacén y oficina no existe en el catálogo de CEDIS,
              así que no se pueden atribuir a ninguno. Aparecen en su propia fila en vez de
              esconderse, para que la suma de la tabla cuadre con los indicadores de arriba.
            </p>
            <p>
              <b>No es un caso raro:</b> son pocas operaciones pero muy grandes, y se llevan el 61%
              del importe. Una línea sin CEDIS vale de media veinticinco veces más que una normal.
            </p>
            <p className="manual-nota">
              Era el 65% hasta que el cruce de CEDIS pasó a usar la oficina sola cuando el par
              almacén + oficina no existe en el catálogo. Lo que queda se concentra: cuatro
              combinaciones de almacén y oficina explican el 71% del hueco, y esos almacenes no
              aparecen en el catálogo de CEDIS de ninguna forma. Está pendiente de que el cliente diga
              a qué CEDIS corresponden. Hasta entonces, cualquier análisis por CEDIS cubre el 39% del
              dinero.
            </p>
          </div>
          <DemoSinAsignar />
        </div>
      </section>

      <section className="manual-seccion" id="unidades">
        <h2>Por qué las cantidades no se suman</h2>
        <div className="manual-doble">
          <div>
            <p>
              Las cantidades vienen en unidades mezcladas — cajas, piezas, paquetes, sacos, kilos — y
              sumarlas entre sí no significaría nada. Por eso la tabla las muestra separadas por
              unidad y no verás nunca un total de cantidad.
            </p>
            <p>
              La única cantidad comparable es la de <b>cajas</b>, y ya existe en las tres etapas: en
              facturado viene de SAP, en vendido de la conversión de la unidad de venta, y en cobrado
              se reparte la de la factura según la proporción cobrada. Es también la unidad en la que
              se paga la comisión, así que no es un detalle menor.
            </p>
            <p className="manual-nota">
              Con precisión: es la cantidad en la <b>unidad de manejo</b> de cada producto, que suele
              ser la caja pero a veces es el paquete o el saco. Se llama «cajas» porque es como se
              habla de ella, no porque todo se mida en cajas.
            </p>
          </div>
          <DemoUnidades />
        </div>
      </section>

      <section className="manual-seccion" id="filtros">
        <h2>Los filtros</h2>
        <p>
          El periodo se elige en el panel de la izquierda. La división, el CEDIS y el tipo de venta se
          filtran <b>pulsando sobre la propia gráfica</b>: una barra, un trozo del donut, un mes.
        </p>
        <p>
          Todo se aplica en el servidor y queda escrito en la dirección de la página: puedes guardar
          el enlace o mandárselo a alguien y verá exactamente lo mismo, sin explicarle qué tocar.
        </p>
        <p className="manual-nota">
          Ojo: al filtrar por un CEDIS concreto desaparece la fila «Sin asignar», porque esas
          operaciones no pertenecen a ningún CEDIS. Los totales bajarán mucho respecto a la vista sin
          filtrar.
        </p>
      </section>

      <section className="manual-seccion" id="falta">
        <h2>Qué falta todavía</h2>
        <p>
          Nada de esto se resuelve con más SQL: son datos que solo tiene el cliente. Está aquí a la
          vista para que se sepa qué se está esperando.
        </p>
        <ul className="flujo-manual-pendientes">
          <li>
            <b>Traspasos</b> — falta el código de movimiento de MB51 para validar la entrada de
            producto al CEDIS.
          </li>
          <li>
            <b>Mapeo de CEDIS</b> — las doce combinaciones de almacén y oficina que concentran el
            importe sin asignar.
          </li>
          <li>
            <b>Detalle por marca o línea de producto</b> — depende del export de los SETs de producto
            (GS03).
          </li>
          <li>
            <b>Cálculo de comisión</b> — además de lo anterior, falta la tabla oficial de tarifas
            (ZSDFI_001). Es el módulo de Comisiones, todavía sin construir.
          </li>
          <li>
            <b>Conciliación documental</b> — falta saber qué rango de números de proveedor identifica
            a los comisionistas.
          </li>
        </ul>
      </section>
    </>
  );
}
