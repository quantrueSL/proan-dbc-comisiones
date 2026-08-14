"use client";

// El recorrido del producto, en cuatro capas: la pieza central del manual.
//
// Es un diagrama pulsable, no una ilustración: cada eslabón abre su ficha con
// la tabla de SAP de la que sale, su llave, su fecha, su importe y lo que hay
// que saber antes de fiarse de él. Todo eso está documentado en
// `Datos/Comisiones_DBC_Borrador_Tecnico.md` (apartados 4.x) y en
// `data/Resumen.md`; aquí se cuenta en cristiano.
//
// Las cifras llevan SIEMPRE la fecha de la corrida a la vista. Son de una
// validación concreta, no el dato de hoy: el dato de hoy está en la pantalla de
// Flujo de producto, y un número sin fecha en un manual envejece mintiendo.

import { useState } from "react";
import Link from "next/link";
import { COLOR_FASE } from "@/features/flujo-producto/fases";
import { Anillo, Contador, Revelar } from "@/features/manual/manual-animaciones";

/** Fecha de la corrida de la que salen las cifras de abajo. */
export const CORRIDA = "12 de agosto de 2026";

export type Capa = {
  clave: string;
  titulo: string;
  breve: string;
  que: string;
  fuente: string;
  llave: string;
  fecha: string;
  monto: string;
  nota: string;
  resuelta: boolean;
  cifras: { lineas: number; monto: number } | null;
};

/** Exportadas para poder fijarlas en un test: son la columna vertebral del
 *  manual y de lo que la plataforma promete tener resuelto. */
export const CAPAS: Capa[] = [
  {
    clave: "traspasos",
    titulo: "Traspasos",
    breve: "entra al CEDIS",
    que: "La entrada de mercancía al CEDIS: el producto llega antes de poder venderse. Es el primer eslabón del recorrido y el único que todavía no está en la plataforma.",
    fuente: "sap_mseg (transacción MB51)",
    llave: "por confirmar",
    fecha: "por confirmar",
    monto: "por confirmar",
    nota: "Se probó contra el único ejemplo real que mandó el cliente y ninguna combinación de tipo de movimiento (BWART) reproduce su total. No es evidencia de que la tabla esté mal: falta que el cliente diga qué código usa en su MB51.",
    resuelta: false,
    cifras: null
  },
  {
    clave: "vendido",
    titulo: "Vendido",
    breve: "el cliente pide",
    que: "Lo que el cliente pidió. Es un pedido de venta: una intención de compra que todavía no se ha facturado ni cobrado.",
    fuente: "sap_VBAK + sap_VBAP (pedido y sus líneas)",
    llave: "VBELN + POSNR",
    fecha: "ERDAT",
    monto: "NETWR — orientativo",
    nota: "El importe del pedido no cuadra con el de la factura: hay un 11% de diferencia porque los descuentos y rebates se aplican al facturar, no al pedir. La cantidad sí cuadra (0,22% de diferencia), así que no son entregas parciales, es precio. Para hablar de dinero, el de facturado.",
    resuelta: true,
    cifras: { lineas: 1506006, monto: 1867026840.65 }
  },
  {
    clave: "facturado",
    titulo: "Facturado",
    breve: "se emite factura",
    que: "Lo que se facturó de verdad, con su importe fiable. Es la fase con más detalle y la única que trae la cantidad convertida a cajas.",
    fuente: "sap_2lis_13_vditm_billing_document_item",
    llave: "billing_document",
    fecha: "billing_date",
    monto: "amount_mxn — el fiable",
    nota: "La conversión a caja no hay que calcularla: el campo stockkeeping_units ya trae la cantidad convertida, validada contra miles de líneas por material. Es la única fase que la tiene, y por eso la métrica «Cajas» solo se activa aquí.",
    resuelta: true,
    cifras: { lineas: 1745163, monto: 1903510061.8 }
  },
  {
    clave: "cobrado",
    titulo: "Cobrado",
    breve: "entra el dinero",
    que: "El dinero efectivamente cobrado y compensado. Es el eslabón que importa: la comisión se paga sobre esto y solo sobre esto.",
    fuente: "sap_pago (unido por billing_document)",
    llave: "billing_document",
    fecha: "clearing_date",
    monto: "paid_amount_mxn",
    nota: "Va por documento de factura, no por línea: por eso son muchas menos filas para un importe parecido al de facturado. Una factura emitida no genera comisión hasta que se compensa, y las ventas a crédito tardan.",
    resuelta: true,
    cifras: { lineas: 51763, monto: 1758736858.44 }
  }
];

const dinero = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0
});
const entero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });

export function ManualRecorrido() {
  const [activa, setActiva] = useState("cobrado");
  const capa = CAPAS.find((c) => c.clave === activa) ?? CAPAS[3];

  return (
    <section className="manual-seccion" id="recorrido">
      <h2>El recorrido del producto</h2>
      <p>
        La misma venta pasa por cuatro momentos distintos, y cada uno vive en una tabla distinta de
        SAP, con su propia llave y su propia fecha. Juntarlos es, literalmente, la mitad del
        proyecto. <b>Pulsa un eslabón</b> para ver de dónde sale.
      </p>

      {/* Diagrama pulsable. La cajita que lo recorre entra y sale de cada
          eslabón: pasa por detrás de las tarjetas, no por encima. */}
      <div className="manual-flujo">
        <div className="manual-flujo-pista" aria-hidden="true">
          <span className="manual-flujo-caja" />
        </div>
        <ol className="manual-flujo-nodos">
          {CAPAS.map((paso, i) => (
            <li key={paso.clave}>
              <button
                aria-pressed={paso.clave === activa}
                data-activa={paso.clave === activa ? "si" : "no"}
                data-resuelta={paso.resuelta ? "si" : "no"}
                onClick={() => setActiva(paso.clave)}
                style={{ ["--tono" as string]: COLOR_FASE[paso.clave] ?? "#9a948c" }}
                type="button"
              >
                <small>{i + 1}</small>
                <b>{paso.titulo}</b>
                <span>{paso.breve}</span>
                {paso.resuelta ? null : <em>por validar</em>}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {/* `key` fuerza el remontaje: así la ficha vuelve a entrar animada y los
          contadores vuelven a contar cada vez que se cambia de eslabón. */}
      <div className="manual-ficha" key={capa.clave} style={{ ["--tono" as string]: COLOR_FASE[capa.clave] ?? "#9a948c" }}>
        <div className="manual-ficha-texto">
          <h3>
            <i aria-hidden="true" />
            {capa.titulo}
            {capa.resuelta ? null : <span className="manual-etiqueta">sin validar</span>}
          </h3>
          <p>{capa.que}</p>
          <p className="manual-nota">{capa.nota}</p>
        </div>

        <dl className="manual-ficha-datos">
          <div>
            <dt>De dónde sale</dt>
            <dd>
              <code>{capa.fuente}</code>
            </dd>
          </div>
          <div>
            <dt>Llave</dt>
            <dd>
              <code>{capa.llave}</code>
            </dd>
          </div>
          <div>
            <dt>Fecha</dt>
            <dd>
              <code>{capa.fecha}</code>
            </dd>
          </div>
          <div>
            <dt>Importe</dt>
            <dd>
              <code>{capa.monto}</code>
            </dd>
          </div>
        </dl>

        {capa.cifras ? (
          <div className="manual-ficha-cifras">
            <div>
              <span>Líneas</span>
              <strong>
                <Contador formato={(n) => entero.format(Math.round(n))} valor={capa.cifras.lineas} />
              </strong>
            </div>
            <div>
              <span>Importe</span>
              <strong>
                <Contador formato={(n) => dinero.format(n)} valor={capa.cifras.monto} />
              </strong>
            </div>
            <small>
              Corrida del {CORRIDA}, enero–agosto de 2026. No es el dato de hoy: eso está en{" "}
              <Link href="/flujo-producto">Flujo de producto</Link>.
            </small>
          </div>
        ) : (
          <div className="manual-ficha-cifras is-vacia">
            <p>
              Sin cifras todavía. Esta capa no se puede publicar sin validarla contra el MB51 del
              cliente: enseñar un número que no cuadra con el suyo es peor que no enseñar ninguno.
            </p>
          </div>
        )}
      </div>

      <Revelar className="manual-progreso">
        <Anillo etiqueta="capas de datos resueltas" hechas={3} total={4} />
        <div>
          <b>Vendido, facturado y cobrado están resueltos y validados.</b>
          <p>
            Los tres corren ya sobre BigQuery en una sola vista, con la división de producto y el
            canal al 100% de cobertura y el CEDIS al 92,5% de las líneas. Falta la primera capa, los
            traspasos, que depende de un dato del cliente.
          </p>
        </div>
      </Revelar>
    </section>
  );
}
