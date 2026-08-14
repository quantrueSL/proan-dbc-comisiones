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
    ruta: null,
    estado: "bloqueado",
    que: "El cálculo de lo que hay que pagar a cada comisionista: importe fijo por caja, que cambia según el SET de producto, el CEDIS y la oficina de venta.",
    falta: "Falta el export de GS03 —los SETs de producto, sin los que no se puede agrupar un material por marca— y la tabla oficial de tarifas ZSDFI_001. La estructura de la tarifa ya se entiende, pero está derivada de los reportes del cliente, no de la fuente oficial."
  },
  {
    clave: "conciliacion",
    titulo: "Conciliación",
    ruta: null,
    estado: "bloqueado",
    que: "El emparejamiento de cada factura de comisionista con su documento de pago, descargable al máximo detalle como respaldo ante el SAT.",
    falta: "La fuente ya tiene la estructura necesaria (proveedor, compensación, importe). Falta saber qué rango de números de proveedor identifica a los comisionistas: sin eso no se pueden separar del resto de proveedores del grupo."
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
              texto: "Un importe fijo por caja que cambia según el producto, el CEDIS y la oficina. Y solo sobre lo que ya se cobró."
            },
            {
              titulo: "Guarda el respaldo",
              texto: "Cada factura de comisionista emparejada con su pago, descargable al detalle, para cuando lo pida el SAT."
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
                La comisión se devenga sobre la venta <b>compensada</b>, no sobre la facturada. Entre
                emitir la factura y ver el dinero puede pasar un crédito entero, así que hace falta
                mirar la misma venta en tres momentos distintos y no confundirlos nunca. Casi todos
                los malentendidos de este proyecto empiezan aquí.
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
          Uno funciona con datos reales y dos están esperando información del cliente. Están a la
          vista igualmente, para que se sepa qué falta y por qué.
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
          Los dos módulos bloqueados no simulan datos: su endpoint devuelve un{" "}
          <code>501</code> explícito y la pantalla cae a una vista previa marcada como ejemplo. Es a
          propósito. Un número inventado en una pantalla de comisiones termina en una liquidación.
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
          Quien vende el producto y cobra comisión por ello. En SAP figura como un proveedor, y ahí
          está el problema: sin saber qué rango de números de proveedor le corresponde, no se puede
          separar de los demás proveedores del grupo.
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
          El tipo de producto: <b>H</b> huevo, <b>BO</b> botana, <b>A</b> abarrote, <b>IA</b>{" "}
          alimento. Cobertura del 100% de las líneas.
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
          transacción <code>GS03</code>. La tarifa de comisión cambia por SET, así que sin ese export
          no hay cálculo posible.
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
          caja, y por eso la métrica «Cajas» solo se activa en esa fase.
        </>
      )
    },
    {
      termino: "Tabla gold",
      definicion: (
        <>
          La tabla ya agregada por día que lee esta plataforma (
          <code>DBC_gold_flujo_producto_diario</code>). Se construye a partir de la vista que une
          vendido, facturado y cobrado, y por eso la pantalla responde rápido sin volver a recorrer
          millones de líneas.
        </>
      )
    }
  ];

  return (
    <section className="manual-seccion" id="glosario">
      <h2>Glosario</h2>
      <p>Las nueve palabras que hacen falta para entender el resto.</p>
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
