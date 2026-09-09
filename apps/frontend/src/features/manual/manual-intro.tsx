// Qué es la plataforma, qué problema resuelve y en qué estado está cada módulo.
//
// Sin "use client" a propósito: aquí no hay estado, solo texto. Lo que se mueve
// son los envoltorios `Revelar`, que sí son de cliente. Un componente de
// servidor puede montar uno de cliente y pasarle hijos, y así el texto del
// manual —que es la parte que importa— sale ya escrito en el HTML.
//
// Todo lo que se afirma aquí está en `README.md`, en
// `Datos/Comisiones_DBC_Borrador_Tecnico.md` (apartados 1 y 2) y en
// `data/Resumen.md`. Si algo cambia allí, cambia aquí.

import type { ReactNode } from "react";
import Link from "next/link";
import { Revelar } from "@/features/manual/manual-animaciones";

const MODULOS: {
  clave: string;
  titulo: string;
  ruta: string | null;
  estado: "activo" | "bloqueado";
  que: string;
  falta: string | null;
}[] = [
  {
    clave: "flujo",
    titulo: "Flujo de producto",
    ruta: "/flujo-producto",
    estado: "activo",
    que: "Vendido, facturado y cobrado por CEDIS, división y tipo de venta, día a día y sobre datos reales de BigQuery.",
    falta: null
  },
  {
    clave: "comisiones",
    titulo: "Comisiones",
    ruta: "/comisiones",
    estado: "activo",
    que: "Cuánto se le debe a cada comisionista: un importe fijo por caja o por kilo, según el producto, el CEDIS y quién vende. Cubre ya cerca del 92% de lo facturado en las divisiones que opera DBC.",
    falta: "En una parte de las oficinas todavía no se sabe qué comisionista cobra ahí, así que esas líneas se agrupan como «sin comisionista» en vez de repartirse a alguien al azar. Y de lo que sí se calcula, solo una parte ya tiene un pago real con el que compararse — el resto es venta que aún no se ha cobrado, no un error de cálculo."
  },
  {
    clave: "conciliacion",
    titulo: "Conciliación",
    ruta: "/conciliacion",
    estado: "activo",
    que: "La hoja que hoy se arma a mano cada semana —qué se vendió, a qué tarifa, cuánta comisión— ya sale sola, lista para comparar contra lo que de verdad se le pagó a cada comisionista.",
    falta: "Compara el total de la semana contra el pago, no factura por factura. La fecha que junta ambos lados es la de la venta, no la del cobro — parece razonable, pero falta que el cliente lo confirme. Y hay un puñado de comisionistas (~$5.1 M) con comisión calculada pero sin ningún pago encontrado: vale la pena revisarlos antes de dar ese número por bueno."
  }
];

export function ManualIntro() {
  return (
    <>
      <section className="manual-seccion" id="que-es">
        <h2>Qué es esto</h2>
        <p className="manual-entradilla">
          DBC es el distribuidor del grupo Proan: recibe producto y lo mueve a sus CEDIS, que lo
          venden al cliente final. Por cada venta hay una comisión que pagar. Esta plataforma existe
          para saber, con datos y no de memoria, <b>cuánta y cuándo</b>.
        </p>

        <div className="manual-tarjetas">
          {[
            {
              titulo: "Sigue el producto",
              texto: "De la entrada al CEDIS hasta el cobro, por CEDIS, división y tipo de venta. Es la pantalla de Flujo de producto."
            },
            {
              titulo: "Calcula la comisión",
              texto: "Un importe fijo por caja o por kilo, según el producto, el CEDIS y quién vende. Ya cubre cerca del 92% de lo facturado."
            },
            {
              titulo: "Guarda el respaldo",
              texto: "La comisión calculada de cada comisionista, comparada contra lo que de verdad se le pagó, exportable a Excel con el detalle de cada factura."
            }
          ].map((tarjeta, i) => (
            <Revelar className="manual-tarjeta" key={tarjeta.titulo} orden={i}>
              <b>{tarjeta.titulo}</b>
              <p>{tarjeta.texto}</p>
            </Revelar>
          ))}
        </div>

        <p className="manual-nota">
          Los datos no se teclean en ningún sitio: se leen de SAP a través de BigQuery (proyecto{" "}
          <code>proan-quantrue</code>), que es del grupo entero — Proan, Superdoña, Malta y el resto.
          Por eso todo lo que se enseña aquí pasa antes por un filtro maestro,{" "}
          <code>company_code = &apos;DBC&apos;</code>, y arranca en enero de 2026.
        </p>
      </section>

      <section className="manual-seccion" id="problema">
        <h2>El problema que resuelve</h2>
        <p>
          Parece un problema de informes y no lo es. Son tres problemas distintos, y los tres
          explican por qué la pantalla es como es.
        </p>

        <div className="manual-problemas">
          <Revelar className="manual-problema" orden={0}>
            <span className="manual-problema-num">1</span>
            <div>
              <b>Facturar no es cobrar</b>
              <p>
                La comisión se devenga sobre la venta <b>compensada</b>, no sobre la facturada, y
                entre emitir la factura y ver el dinero puede pasar un crédito entero. Hay que mirar
                la misma venta en tres momentos distintos y no confundirlos nunca — casi todos los
                malentendidos de este proyecto empiezan aquí.
              </p>
            </div>
          </Revelar>

          <Revelar className="manual-problema" orden={1}>
            <span className="manual-problema-num">2</span>
            <div>
              <b>El dato está repartido en cuatro tablas</b>
              <p>
                Cada eslabón del recorrido vive en su propia tabla de SAP, con su propia llave y su
                propia fecha; el importe del pedido no coincide con el de la factura; y la base es
                del grupo entero, no de DBC. Hasta hay fechas de facturación con el año 2201. Juntar
                todo eso y que cuadre <b>es</b> el trabajo.
              </p>
            </div>
          </Revelar>

          <Revelar className="manual-problema" orden={2}>
            <span className="manual-problema-num">3</span>
            <div>
              <b>Y hay que poder demostrarlo</b>
              <p>
                El pago de comisiones se justifica ante el SAT documento por documento. No basta con
                acertar el importe: hay que poder sacar el respaldo de cada peso, factura contra
                pago, cuando llegue la auditoría.
              </p>
            </div>
          </Revelar>
        </div>
      </section>

    </>
  );
}

/** Los módulos van DESPUÉS del recorrido: primero se entiende el camino del
 *  producto y luego qué parte de ese camino cubre cada pantalla. */
export function ManualModulos() {
  return (
    <section className="manual-seccion" id="modulos">
        <h2>Los tres módulos</h2>
        <p>
          Los tres corren sobre datos reales de BigQuery. Cada uno tiene huecos conocidos —
          documentados abajo y, para Comisiones y Conciliación, también en el panel{" "}
          <b>ⓘ</b> de su propia pantalla.
        </p>

        <div className="manual-modulos">
          {MODULOS.map((modulo, i) => (
            <Revelar className="manual-modulo" key={modulo.clave} orden={i}>
              <div data-estado={modulo.estado}>
                <header>
                  <b>{modulo.titulo}</b>
                  <span className="manual-estado" data-estado={modulo.estado}>
                    {modulo.estado === "activo" ? "funcionando" : "bloqueado"}
                  </span>
                </header>
                <p>{modulo.que}</p>
                {modulo.falta ? <p className="manual-modulo-falta">{modulo.falta}</p> : null}
                {modulo.ruta ? (
                  <Link className="manual-enlace" href={modulo.ruta}>
                    Abrir el módulo →
                  </Link>
                ) : null}
              </div>
            </Revelar>
          ))}
        </div>

        <p className="manual-nota">
          El periodo se elige siempre en el panel lateral. En <b>Flujo de producto</b>, la división,
          el CEDIS y el tipo de venta se filtran pulsando sobre la propia gráfica, y todo queda en la
          dirección de la página —se puede guardar el enlace o mandarlo—. <b>Comisiones</b> filtra
          igual, pulsando CEDIS o mes en sus gráficas, pero ese filtro no se guarda todavía en el
          enlace. <b>Conciliación</b> no tiene gráficas que pulsar: se filtra con los desplegables del
          panel, y un clic en una fila abre el detalle de ese comisionista.
        </p>
    </section>
  );
}

export function ManualGlosario() {
  const TERMINOS: { termino: string; definicion: ReactNode }[] = [
    {
      termino: "CEDIS",
      definicion: (
        <>
          Centro de distribución. Aquí es, técnicamente, una combinación de almacén (
          <code>storage_location</code>) y oficina de venta (<code>sales_office</code>) que existe en
          el catálogo <code>dm_cedis</code>. Si esa combinación no está en el catálogo, la venta sale
          como «Sin asignar».
        </>
      )
    },
    {
      termino: "Comisionista",
      definicion: (
        <>
          Quien vende el producto y cobra comisión por ello. Antes era difícil saber quién, en
          algunas oficinas: se deducía por texto de una tabla que no estaba pensada para eso. Ahora
          hay una tabla propia que identifica a cada comisionista de forma directa; queda un resto de
          oficinas sin resolver, repartido entre todas las divisiones.
        </>
      )
    },
    {
      termino: "Sociedad (DBC/PAN)",
      definicion: (
        <>
          La empresa del grupo que factura la venta. Huevo se factura por las dos, y la comisión de
          PAN es la mayor parte del total — por eso Comisiones y Conciliación la llevan siempre como
          filtro o columna aparte, para no mezclar los dos negocios en un solo número.
        </>
      )
    },
    {
      termino: "Compensado (cobrado)",
      definicion: (
        <>
          El dinero cobrado y ya aplicado contra su factura (<code>clearing_date</code>). Es el único
          momento que devenga comisión.
        </>
      )
    },
    {
      termino: "División de producto",
      definicion: (
        <>
          El tipo de producto: <b>H</b> huevo, <b>BO</b> botana, <b>IA</b> alimento (croqueta),{" "}
          <b>A</b> abarrote, <b>L</b> leche. Cobertura del 100% de las líneas.
        </>
      )
    },
    {
      termino: "Tipo de venta",
      definicion: <>Cómo se vende: VTA EN RUTA, MAYOREO, MED MAYOREO o EXTRAS.</>
    },
    {
      termino: "SET",
      definicion: (
        <>
          La agrupación de materiales por marca o línea que el cliente mantiene en SAP con la
          transacción <code>GS03</code>. Llegó el 24 de agosto de 2026; hoy la tarifa de comisión se
          busca por división + oficina + SET + tipo de venta.
        </>
      )
    },
    {
      termino: "Traspaso",
      definicion: (
        <>
          La entrada de mercancía al almacén de un CEDIS, la que el cliente saca con{" "}
          <code>MB51</code>. Es el primer eslabón del recorrido y el que falta.
        </>
      )
    },
    {
      termino: "Caja (CJ)",
      definicion: (
        <>
          La unidad en la que se paga la comisión. Solo facturado trae la cantidad ya convertida a
          caja, y por eso la métrica «Cajas» solo se activa en esa fase. Es la misma unidad de manejo
          que usan Comisiones y Conciliación para calcular la tarifa: kilo en Huevo y Alimento, caja,
          saco, paquete o pieza en el resto, según el producto.
        </>
      )
    },
    {
      termino: "Tabla gold",
      definicion: (
        <>
          La tabla ya agregada por día (o por periodo de pago) que lee cada pantalla —
          <code>DBC_gold_flujo_producto_diario</code> en Flujo de producto, y su propia tabla gold en
          Comisiones y Conciliación. Se construyen a partir de la vista que junta las fuentes de SAP,
          y por eso la pantalla responde rápido sin volver a recorrer millones de líneas en cada clic.
        </>
      )
    }
  ];

  return (
    <section className="manual-seccion" id="glosario">
      <h2>Glosario</h2>
      <p>Las diez palabras que hacen falta para entender el resto.</p>
      <div className="manual-glosario">
        {TERMINOS.map((entrada) => (
          <details key={entrada.termino}>
            <summary>
              <span>{entrada.termino}</span>
              <i aria-hidden="true" />
            </summary>
            <p>{entrada.definicion}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
