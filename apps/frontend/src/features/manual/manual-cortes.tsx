// Conciliación por cortes: la forma de conciliar, y el apartado más largo del manual.
//
// Dos apartados: `cortes` (la idea, las tres palabras y cómo se lee la tabla) y
// `cortes-trabajo` (conciliar un pago, paso a paso, y los casos raros). Los
// nombres de botones y estados son los de la pantalla tal cual: si cambian en
// `conciliacion-cortes/`, cambian aquí. Los estados salen de `ETIQUETA_ESTADO`
// para que no puedan separarse.
//
// Sin cifras de la medición a propósito (decisión de Silvana, 27-oct): el
// manual explica cómo se usa; los números están en la propia pantalla.
//
// Sin "use client": solo texto, como `manual-intro.tsx`.

import type { ReactNode } from "react";
import Link from "next/link";
import { ETIQUETA_ESTADO } from "@/features/conciliacion-cortes/cortes-logica";
import { Revelar } from "@/features/manual/manual-animaciones";
import type { CortesEstado } from "@/types/comisiones";

const PALABRAS: { titulo: string; texto: string }[] = [
  {
    titulo: "Pago",
    texto: "Un documento de pago de comisión en SAP. Se identifica por su número de documento, no por su texto. En DBC, Huevo y Abarrotes se pagan juntos, así que son un solo pago."
  },
  {
    titulo: "Ventana",
    texto: "Los días de cobro que cubre un pago. Por defecto sale del texto del pago («12 AL 18 SEP»), acomodado a semanas de sábado a viernes y al fin de mes."
  },
  {
    titulo: "Corte",
    texto: "El borde que comparten dos pagos seguidos. Moverlo un día pasa lo cobrado ese día de un pago al otro: lo que gana uno lo pierde su vecino."
  }
];

const ESTADOS: { estado: CortesEstado; texto: string }[] = [
  { estado: "ok", texto: "La comisión calculada en su ventana y lo pagado difieren en $1 o menos." },
  { estado: "sug", texto: "No cuadra, pero mover un corte unos días (o sumarle el cierre de mes) lo deja exacto. La pantalla propone el ajuste; nunca lo aplica sola." },
  { estado: "sin", texto: "No cuadra y ningún ajuste de hasta 3 días lo arregla. Casi siempre es diferencia de monto, no de fechas: hay que revisarlo a mano." },
  { estado: "sinv", texto: "El texto del pago no trae fechas que se puedan leer, así que no se sabe qué cobros cubre. Se le pone la ventana a mano." },
  { estado: "cons", texto: "Alguien lo revisó y lo cerró. Sus cortes quedan congelados." }
];

const PASOS: { titulo: string; texto: ReactNode }[] = [
  {
    titulo: "Elige un pago",
    texto: (
      <>
        Pulsa una celda y se abre su panel a la derecha, con el documento de SAP, el texto del pago
        y la fecha en que se pagó. <b>Siguiente pendiente</b> (o la tecla <b>N</b>) salta al próximo
        pago que no cuadra ni está consolidado; <b>Pago anterior</b> y <b>Pago siguiente</b> recorren
        los del mismo comisionista, aunque caigan en otro mes.
      </>
    )
  },
  {
    titulo: "Mira la línea de tiempo",
    texto: (
      <>
        El pago aparece entre sus vecinos, con la comisión cobrada de cada día y los cortes que los
        separan. Si entre dos pagos hay días que no cubre ninguno, se ven como un tramo{" "}
        <b>Sin pago</b>. <b>Ampliar contexto</b> enseña dos pagos a cada lado en vez de uno.
      </>
    )
  },
  {
    titulo: "Si hay sugerencia, revísala",
    texto: (
      <>
        Dice qué corte mover y cómo quedaría la diferencia de cada pago afectado, antes y después.
        La marca <b>Única opción exacta</b> o <b>Varias opciones, la de menor cambio</b> indica qué
        tan segura es. <b>Aplicar</b> la guarda; <b>Descartar</b> deja el pago como «Sin
        explicación», y se puede deshacer con <b>Recuperar la sugerencia</b>.
      </>
    )
  },
  {
    titulo: "Si no, ajusta a mano",
    texto: (
      <>
        Las flechas <b>◀ ▶</b> de cada corte lo mueven un día. Cada cambio se guarda solo, y la
        diferencia de los dos pagos se recalcula al momento. <b>Volver a la ventana estándar</b>{" "}
        deshace todo lo que se le hizo a ese pago.
      </>
    )
  },
  {
    titulo: "Asigna el cierre de mes",
    texto: (
      <>
        Lo cobrado el último día del mes con cobros no entra en el pago de su semana: se paga
        después, en un pago posterior que cambia de un mes a otro. Mientras nadie lo asigne, queda
        como <b>Cierre de mes, sin asignar</b>. En el panel del pago que lo incluye, marca esos días
        en el bloque <b>Cierre de mes</b> y pulsa <b>Incluir en este pago</b>; antes de guardar, la
        pantalla dice en cuánto quedaría la diferencia. <b>Quitar</b> lo devuelve.
      </>
    )
  },
  {
    titulo: "Consolida",
    texto: (
      <>
        <b>Consolidar este pago</b> lo da por revisado y congela sus dos cortes. Si no cuadra, el
        botón dice <b>Consolidar con diferencia de $…</b>: se puede, pero queda dicho. Para revisar
        de golpe, <b>Consolidar lo que cuadra</b> consolida cada fila de izquierda a derecha y se
        detiene en el primer pago que no cuadra.
      </>
    )
  }
];

export function ManualCortes() {
  return (
    <>
      <section className="manual-seccion" id="cortes">
        <h2>Conciliación por cortes</h2>
        <p className="manual-entradilla">
          Es la forma de conciliar. Se parte de lo que de verdad se le pagó a cada comisionista —un
          documento de SAP— y se buscan los cobros que lo justifican. Lo que se ajusta no es el
          pago, sino <b>qué días de cobro le tocan</b>.
        </p>

        <div className="manual-tarjetas">
          {PALABRAS.map((palabra, i) => (
            <Revelar className="manual-tarjeta" key={palabra.titulo} orden={i}>
              <b>{palabra.titulo}</b>
              <p>{palabra.texto}</p>
            </Revelar>
          ))}
        </div>

        <h3>Cómo se lee la tabla</h3>
        <p>
          Hay una fila por comisionista, con lo pagado y lo calculado de cada semana. Pulsa{" "}
          <b>▶</b> junto al nombre para abrirla por división; <b>Desplegar todo</b> las abre todas.
          Cada celda es un pago y trae tres cifras: <b>Pag.</b>, <b>Calc.</b> y <b>Dif.</b>, que es
          calculado menos pagado. Un pago que cubre más de una semana ocupa varias columnas.
        </p>
        <p>
          El <b>Mes</b> coloca sus semanas en la tabla, y <b>◀ Semana anterior</b> y{" "}
          <b>Semana siguiente ▶</b> la desplazan de una en una. División y Comisionista filtran;{" "}
          <b>Solo lo que requiere acción</b> esconde lo que ya cuadra o ya está consolidado. Arriba,
          un contador por estado y la <b>Comisión calculada sin pago</b>: cobros con comisión que no
          caen en la ventana de ningún pago, cierre de mes incluido.
        </p>

        <h3>Los cinco estados de un pago</h3>
        <ol className="flujo-manual-fases">
          {ESTADOS.map(({ estado, texto }) => (
            <li key={estado}>
              <i aria-hidden="true" className={`cortes-punto is-${estado}`} />
              <div>
                <b>{ETIQUETA_ESTADO[estado]}</b>
                <span>{texto}</span>
              </div>
            </li>
          ))}
        </ol>

        <p className="manual-nota">
          Solo el rol <b>admin</b> puede mover cortes, aplicar sugerencias, consolidar, reabrir y
          comentar. Los demás ven lo mismo, en solo lectura, y también pueden bajar el Excel. Lo que
          se guarda lo ve todo el equipo al momento; si dos personas editan la misma fila a la vez,
          la pantalla avisa y carga lo último.
        </p>

        <Link className="manual-enlace" href="/conciliacion-cortes">
          Abrir Conciliación por cortes →
        </Link>
      </section>

      <section className="manual-seccion" id="cortes-trabajo">
        <h2>Conciliar un pago</h2>
        <p>El recorrido de siempre, en el panel que se abre al pulsar un pago:</p>

        <div className="manual-problemas">
          {PASOS.map((paso, i) => (
            <Revelar className="manual-problema" key={paso.titulo} orden={i}>
              <span className="manual-problema-num">{i + 1}</span>
              <div>
                <b>{paso.titulo}</b>
                <p>{paso.texto}</p>
              </div>
            </Revelar>
          ))}
        </div>

        <h3>Después de consolidar</h3>
        <p>
          Si los cobros o el pago de SAP cambian después de consolidar, la celda marca{" "}
          <b>⚠ Cambió</b> y el panel dice cuál sería la cifra de hoy. Lo consolidado no se mueve solo:
          para tocar un corte congelado hay que pulsar <b>Reabrir</b>, que avisa de que eso cambia lo
          que ya se reportó.
        </p>

        <h3>Casos que piden algo distinto</h3>
        <ul className="flujo-manual-pendientes">
          <li>
            <b>Pago sin ventana</b> — escribe su inicio y su fin y pulsa <b>Fijar ventana</b>. A partir
            de ahí se compara como cualquier otro.
          </li>
          <li>
            <b>Pago sin cálculo</b> — hay pago, pero ninguna comisión calculada para ese comisionista
            y esa división en su ventana. No se arregla moviendo cortes.
          </li>
          <li>
            <b>Guardado de un documento que ya no está en SAP</b> — un ajuste o un consolidado de un
            pago que se canceló o se volvió a cargar. Mientras siga ahí, esos cobros pueden quedar sin
            pago; <b>Quitar</b> lo borra.
          </li>
        </ul>

        <h3>Lo que queda escrito</h3>
        <ul className="flujo-manual-pendientes">
          <li>
            <b>Comentarios</b> — cualquier nota sobre el pago. La celda lo marca con 💬, y solo quien
            lo escribió puede borrarlo.
          </li>
          <li>
            <b>Historial de esta fila</b> — quién movió, aplicó, consolidó o reabrió qué, y cuándo.
          </li>
          <li>
            <b>Detalle por producto</b> — la pestaña del panel con lo cobrado en la ventana del pago,
            producto por producto. Si se mueve un corte, cambia con él.
          </li>
          <li>
            <b>Descargar Excel</b> — un libro por pago: resumen (con los comentarios), conciliación
            por producto, pagado contra calculado, detalle diario y detalle de factura. Incluye los
            días de cierre que se le hayan asignado.
          </li>
        </ul>

        <p className="manual-nota">
          Las sugerencias solo prueban fechas. Cuando la diferencia es de monto —un acuerdo especial,
          una factura que no se pagó, una tarifa distinta—, ningún corte la explica y el pago se queda
          «Sin explicación»: ahí es donde hace falta el criterio de quien concilia, y un comentario
          que lo deje dicho.
        </p>
      </section>
    </>
  );
}
