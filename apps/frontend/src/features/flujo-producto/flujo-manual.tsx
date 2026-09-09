// Manual de la pantalla de flujo de producto.
//
// No es un "acerca de": está escrito para que alguien que abre esto por primera
// vez entienda qué está viendo y, sobre todo, no saque conclusiones falsas.
// Dos apartados: `lectura` (qué entra, las tres líneas, cómo se lee) y
// `trampas` (las tres cosas que no se adivinan mirándola: vendido va atrás,
// dos tercios del importe no tenían CEDIS asignado y hoy es residual, y las
// cantidades no se suman entre unidades). Cada trampa lleva su porqué y un
// juguete al lado que hace la cosa MAL a propósito para que se vea el tamaño
// del error — los juguetes están en `manual-demos.tsx`, sin tocar.
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
      "Lo que se facturó de verdad, con su importe fiable. Trae el detalle más fino: material, unidad y cantidad convertida a cajas."
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
      {/* Fusiona lo que antes eran tres apartados (alcance, fases, gráfica):
          es una sola pregunta — "¿qué estoy viendo?" — antes de entrar en las
          trampas concretas de la sección siguiente. */}
      <section className="manual-seccion" id="lectura">
        <h2>Cómo leer Flujo de producto</h2>
        <p>
          Los totales de aquí <b>no son todo lo que factura DBC</b>, y no por un fallo: solo entran
          las divisiones que DBC opera —huevo, botana, croqueta, abarrotes y leche—, ni los cuatro
          almacenes centrales que no pasan por ningún CEDIS y no generan comisión. Las dos exclusiones
          están confirmadas por el cliente; el aviso de la barra superior dice cuánto suman los
          almacenes centrales en el periodo que estés viendo.
        </p>
        <p className="manual-nota">
          Uno de esos almacenes se llama «CEDIS SAN JUAN» en SAP y aun así no es un CEDIS. Un rótulo
          no es una fuente.
        </p>

        <p>
          Cada una de las tres líneas de la gráfica es un <b>momento distinto de la misma venta</b>,
          así que sus importes no tienen por qué coincidir:
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
          Falta una cuarta etapa, los <b>traspasos</b> (la entrada de producto al CEDIS, antes de
          poder venderlo) — pendiente de que el cliente diga cómo la identifica en su propio sistema.
        </p>

        <p>
          Cada día lleva sus tres barras juntas; pasa el ratón por encima para ver las tres cifras de
          ese día. Si el periodo es largo, las barras agrupan por semana o por mes y la leyenda lo
          dice.
        </p>
      </section>

      {/* `manual-doble`: el texto a un lado y el juguete al otro. En pantalla
          ancha se leen juntos —que es como se entienden— y en estrecha se
          apilan solos. Fusiona lo que antes eran tres apartados: vendido,
          sin-asignar y unidades son, las tres, la misma idea — algo de la
          pantalla se puede leer mal si nadie avisa antes. */}
      <section className="manual-seccion" id="trampas">
        <h2>Tres trampas de la pantalla</h2>

        <h3>Vendido va atrás</h3>
        <div className="manual-doble">
          <div>
            <p>
              La tabla de pedidos de SAP dejó de recibir datos nuevos
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
              . No es un fallo de esta herramienta: es la ingesta de SAP, compartida con el resto del
              grupo.
            </p>
            <p className="manual-nota">
              Mientras dure, no compares vendido con facturado en las fechas recientes: parecerá un
              desplome de ventas y solo es una laguna de datos. Y{" "}
              <b>si falta la barra de una fase, es que no hay dato de ese día, no que fuera cero</b> —
              por eso no se dibuja nada en vez de una barra a ras del suelo, que diría que ese día no
              hubo movimiento y sería mentira.
            </p>
          </div>
          <DemoHueco />
        </div>

        <h3>Qué es la fila «Sin asignar»</h3>
        <div className="manual-doble">
          <div>
            <p>
              Son las ventas cuya combinación de almacén y oficina no existe en el catálogo de CEDIS,
              así que no se pueden atribuir a ninguno. Aparecen en su propia fila en vez de
              esconderse, para que la suma de la tabla cuadre con los indicadores de arriba. Al
              filtrar por un CEDIS concreto esta fila desaparece, porque esas ventas no pertenecen a
              ninguno.
            </p>
            <p>
              <b>Hoy es residual:</b> el 0,2% del importe. Pero conviene saber de dónde viene, porque
              durante meses fue el 65% y esa cifra circuló.
            </p>
            <p className="manual-nota">
              Aquel 65% no era un fallo de mapeo: dos tercios eran divisiones que DBC no opera y
              almacenes centrales que, correctamente, no pertenecen a ningún CEDIS — ninguna de las
              dos cosas se enseña ya aquí. El tercio que sí lo era se cerró con la lista de almacenes
              que mandó el cliente. Lo que queda sin asignar de verdad son 5.485 líneas, $1,3 M.
            </p>
          </div>
          <DemoSinAsignar />
        </div>

        <h3>Las cantidades no se suman</h3>
        <div className="manual-doble">
          <div>
            <p>
              Las cantidades vienen en unidades mezcladas — cajas, piezas, paquetes, sacos, kilos — y
              sumarlas entre sí no significaría nada. Por eso la tabla las muestra separadas por
              unidad y no verás nunca un total de cantidad.
            </p>
            <p>
              La única cantidad comparable es la de <b>cajas</b>, y ya existe en las tres etapas. Es
              también la unidad en la que se paga la comisión —la misma que usan Comisiones y
              Conciliación para calcular la tarifa—, así que no es un detalle menor.
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

      <section className="manual-seccion" id="falta">
        <h2>Qué falta todavía</h2>
        <p>
          Nada de esto se resuelve con más SQL: son respuestas que solo tiene el cliente, o números
          que todavía no se pueden cruzar contra nada. Está aquí a la vista para que se sepa qué se
          está esperando.
        </p>
        <ul className="flujo-manual-pendientes">
          <li>
            <b>Flujo de producto</b> — todavía no se ve la entrada de mercancía al CEDIS, el primer
            paso antes de vender. Depende de que el cliente confirme cómo la identifica en su propio
            sistema.
          </li>
          <li>
            <b>Comisiones</b> — en una parte de las oficinas no se sabe todavía a quién pagarle. Y del
            total calculado, solo una parte tiene ya un pago real con el que compararse: el resto es
            cartera que aún no se cobra, no un error.
          </li>
          <li>
            <b>Conciliación</b> — compara el total de la semana, no factura por factura. Usa la fecha
            de venta para emparejar el pago, pendiente de confirmar con el cliente. Y unos pocos
            comisionistas salen con comisión calculada pero sin ningún pago encontrado — a revisar
            caso por caso.
          </li>
        </ul>
      </section>
    </>
  );
}
