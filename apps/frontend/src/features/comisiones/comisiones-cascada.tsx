"use client";

// Tabla en cascada: se abre con "+" y cada nivel enseña sus hijos debajo.
//
// LAS DOS TABLAS DE LA PANTALLA SON EL MISMO COMPONENTE con otra lista de
// niveles. Por división: división → CEDIS → comisionista → hoja. Por
// comisionista: comisionista → división → hoja. Salen del mismo array de hojas
// que manda el motor, así que abrir un nodo no pide nada al servidor.
//
// LA TRAMPA QUE ESTO TIENE QUE EVITAR, y es la razón de la mitad del código:
// una fila padre NO es la suma de los hijos que se ven. Puede tener hijos
// cerrados, y las listas largas se recortan. Con las cifras alineadas en
// columna, el ojo suma lo visible y da por hecho que cuadra. Tres decisiones
// salen de ahí:
//
//   1. El padre enseña SIEMPRE su total, el de todos sus hijos, abiertos o no.
//   2. Cuando se recorta una lista, la fila «otros N» va con su importe. Nunca
//      se recorta en silencio.
//   3. La sangría lleva un filete a la izquierda, para ver de un vistazo a qué
//      nivel pertenece cada fila.
//
// LA CANTIDAD SOLO APARECE DONDE SIGNIFICA ALGO. Huevo y croqueta se comisionan
// por kilo, botana y leche por caja, así que una fila que abarque varias
// divisiones tendría una cantidad que mezcla kilos con cajas. En esas filas la
// celda va vacía a propósito, no a cero. Es también la razón de que la cascada
// de comisionista parta por división antes que por nada: a partir de ahí cada
// rama tiene una sola unidad.

import { Fragment, useMemo, useState } from "react";
import type { ComisionDesgloseRow } from "@/types/comisiones";

const dinero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 });

function pesos(valor: number) {
  return `$${dinero.format(valor)}`;
}

/** Hijos que se enseñan antes de agrupar el resto en «otros N». El nivel raíz no
 *  se recorta: es la lista de la que se paga y no se puede esconder a nadie. */
const TOPE_HIJOS = 6;

/** Un nivel de la cascada: cómo se saca su clave y cómo se rotula. */
export type NivelCascada = {
  /** Cómo se llama el nivel en el título. De aquí sale la jerarquía escrita, en
   *  vez de repetirla a mano en la pantalla: así no puede decir una cosa y
   *  hacer otra. */
  nombre: string;
  /** Para la columna de la izquierda y para el `key` de React. */
  clave: (fila: ComisionDesgloseRow) => string | null;
  etiqueta: (fila: ComisionDesgloseRow) => string;
  /** Qué se lee cuando la clave es nula. */
  vacio: string;
};

/** El último escalón de cualquier cascada: la llave de la tarifa. Se rotula por
 *  el SET, que es lo que se busca en la hoja del cliente. */
const NIVEL_HOJA = "SET";

/** "División → CEDIS → Comisionista → SET". Sale de los propios niveles. */
export function jerarquia(niveles: NivelCascada[]): string {
  return [...niveles.map((nivel) => nivel.nombre), NIVEL_HOJA].join(" → ");
}

type Totales = {
  monto: number;
  monto_calculable: number;
  comision: number;
  comision_con_cobro: number;
  cantidad_base: number;
  /** Las unidades que hay dentro. Si hay más de una, la cantidad no se enseña. */
  unidades: Set<string>;
};

type Nodo = {
  ruta: string;
  etiqueta: string;
  nivel: number;
  totales: Totales;
  hijos: Nodo[];
  /** La hoja lleva las columnas que hacen verificable la tarifa. */
  hoja: ComisionDesgloseRow | null;
};

function nuevoTotal(): Totales {
  return {
    monto: 0,
    monto_calculable: 0,
    comision: 0,
    comision_con_cobro: 0,
    cantidad_base: 0,
    unidades: new Set()
  };
}

function sumar(destino: Totales, fila: ComisionDesgloseRow) {
  destino.monto += fila.monto;
  destino.monto_calculable += fila.monto_calculable;
  destino.comision += fila.comision;
  destino.comision_con_cobro += fila.comision_con_cobro;
  destino.cantidad_base += fila.cantidad_base;
  if (fila.base_unidad) destino.unidades.add(fila.base_unidad);
}

/**
 * Rótulo de la hoja: lo que identifica una tarifa. El SET manda porque es lo
 * que se busca en la hoja del cliente; el tipo de venta y la oficina van
 * detrás porque completan la llave sin ser lo que nadie busca primero.
 */
function rotuloHoja(fila: ComisionDesgloseRow): string {
  return fila.set ?? "Sin SET";
}

function detalleHoja(fila: ComisionDesgloseRow): string {
  return [fila.tipo_venta ?? "sin tipo de venta", fila.oficina ? `oficina ${fila.oficina}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** Construye el árbol agrupando por los niveles, en orden. */
function construir(filas: ComisionDesgloseRow[], niveles: NivelCascada[], rutaPadre: string, nivel: number): Nodo[] {
  if (nivel >= niveles.length) {
    // Las hojas: una fila por llave de tarifa, sin agrupar más.
    return filas.map((fila) => {
      const totales = nuevoTotal();
      sumar(totales, fila);
      return {
        ruta: `${rutaPadre}/${fila.oficina ?? "-"}|${fila.set ?? "-"}|${fila.tipo_venta ?? "-"}`,
        etiqueta: rotuloHoja(fila),
        nivel,
        totales,
        hijos: [],
        hoja: fila
      };
    });
  }

  const { clave, etiqueta, vacio } = niveles[nivel];
  const grupos = new Map<string | null, { etiqueta: string; filas: ComisionDesgloseRow[] }>();
  for (const fila of filas) {
    const k = clave(fila);
    const grupo = grupos.get(k) ?? { etiqueta: k === null ? vacio : etiqueta(fila), filas: [] };
    grupo.filas.push(fila);
    grupos.set(k, grupo);
  }

  return Array.from(grupos.entries())
    .map(([k, grupo]) => {
      const ruta = `${rutaPadre}/${k ?? "__sin__"}`;
      const totales = nuevoTotal();
      for (const fila of grupo.filas) sumar(totales, fila);
      return {
        ruta,
        etiqueta: grupo.etiqueta,
        nivel,
        totales,
        hijos: construir(grupo.filas, niveles, ruta, nivel + 1),
        hoja: null
      };
    })
    .sort((a, b) => b.totales.comision - a.totales.comision);
}

/** Los primeros N más una fila «otros N» con lo que queda. Sin recortes mudos. */
function recortar(hijos: Nodo[], tope: number, rutaPadre: string): { visibles: Nodo[]; resto: Nodo | null } {
  if (hijos.length <= tope) return { visibles: hijos, resto: null };
  const visibles = hijos.slice(0, tope);
  const sobrantes = hijos.slice(tope);
  const totales = nuevoTotal();
  for (const nodo of sobrantes) {
    totales.monto += nodo.totales.monto;
    totales.monto_calculable += nodo.totales.monto_calculable;
    totales.comision += nodo.totales.comision;
    totales.comision_con_cobro += nodo.totales.comision_con_cobro;
    totales.cantidad_base += nodo.totales.cantidad_base;
    for (const unidad of nodo.totales.unidades) totales.unidades.add(unidad);
  }
  return {
    visibles,
    resto: {
      ruta: `${rutaPadre}/__resto__`,
      etiqueta: `otros ${numero.format(sobrantes.length)}`,
      nivel: hijos[0].nivel,
      totales,
      hijos: [],
      hoja: null
    }
  };
}

function Cantidad({ totales }: { totales: Totales }) {
  // Vacía, no cero: por encima de la división hay kilos y cajas juntos y no
  // existe un número que los represente.
  if (totales.unidades.size !== 1) return <>—</>;
  const [unidad] = Array.from(totales.unidades);
  return (
    <>
      {numero.format(totales.cantidad_base)} <small>{unidad}</small>
    </>
  );
}

export function ComisionesCascada({
  filas,
  niveles,
  encabezado,
  columnaCedis = false
}: {
  filas: ComisionDesgloseRow[];
  niveles: NivelCascada[];
  /** Rótulo de la primera columna: qué se está listando arriba. */
  encabezado: string;
  /** Solo cuando el CEDIS NO es uno de los niveles. Si lo es, la columna
   *  repetiría el rótulo de su propia fila. */
  columnaCedis?: boolean;
}) {
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const raiz = useMemo(() => construir(filas, niveles, "", 0), [filas, niveles]);

  function alternar(ruta: string) {
    setAbiertos((previos) => {
      const siguiente = new Set(previos);
      if (siguiente.has(ruta)) siguiente.delete(ruta);
      else siguiente.add(ruta);
      return siguiente;
    });
  }

  /** Una fila y, si está abierta, las de sus hijos debajo. */
  function pintar(nodo: Nodo, esResto = false): React.ReactNode {
    const abierto = abiertos.has(nodo.ruta);
    const desplegable = nodo.hijos.length > 0 && !esResto;
    const { visibles, resto } = abierto
      ? recortar(nodo.hijos, nodo.nivel === 0 ? Number.POSITIVE_INFINITY : TOPE_HIJOS, nodo.ruta)
      : { visibles: [], resto: null };

    return (
      <Fragment key={nodo.ruta}>
        <tr data-nivel={nodo.nivel} data-resto={esResto ? "si" : undefined}>
          <td>
            <span className="cascada-sangria" style={{ paddingLeft: `${nodo.nivel * 17}px` }}>
              {desplegable ? (
                <button
                  aria-expanded={abierto}
                  className="cascada-mas"
                  onClick={() => alternar(nodo.ruta)}
                  title={abierto ? `Cerrar ${nodo.etiqueta}` : `Ver el detalle de ${nodo.etiqueta}`}
                  type="button"
                >
                  {abierto ? "−" : "+"}
                </button>
              ) : (
                <span className="cascada-mas cascada-mas-hueco" aria-hidden="true" />
              )}
              <span className="cascada-etiqueta">
                {nodo.etiqueta}
                {nodo.hoja ? <em>{detalleHoja(nodo.hoja)}</em> : null}
              </span>
            </span>
          </td>
          {columnaCedis ? <td>{nodo.hoja?.cedis ?? ""}</td> : null}
          <td className="n">
            <Cantidad totales={nodo.totales} />
          </td>
          <td className="n">{pesos(nodo.totales.monto)}</td>
          <td className="n">
            {nodo.totales.monto
              ? `${decimal.format((nodo.totales.monto_calculable / nodo.totales.monto) * 100)}%`
              : "—"}
          </td>
          <td className="n">{pesos(nodo.totales.comision)}</td>
          <td className="n">{pesos(nodo.totales.comision_con_cobro)}</td>
        </tr>
        {visibles.map((hijo) => pintar(hijo))}
        {resto ? pintar(resto, true) : null}
      </Fragment>
    );
  }

  if (!filas.length) return <p className="hydro-muted">Sin comisión que desglosar en el periodo.</p>;

  return (
    <div className="hydro-table-wrap cascada">
      <table>
        <thead>
          <tr>
            <th>{encabezado}</th>
            {columnaCedis ? <th>CEDIS</th> : null}
            <th className="n">Cantidad</th>
            <th className="n">Facturado</th>
            <th className="n">Con tarifa</th>
            <th className="n">Comisión devengada</th>
            <th className="n">Con cobro registrado</th>
          </tr>
        </thead>
        <tbody>{raiz.map((nodo) => pintar(nodo))}</tbody>
      </table>
    </div>
  );
}

// ─── Las dos jerarquías de la pantalla ────────────────────────────────────
//
// El CEDIS es nivel en la de división y solo columna en la de comisionista: un
// comisionista trabaja normalmente en un CEDIS, así que ahí ese nivel sería un
// clic para llegar a un único hijo. Si algún día se reparten entre varios, es
// un elemento más en esta lista.
//
// La oficina nunca es nivel: es un código de cuatro cifras que nadie navega,
// pero sí forma parte de la llave de la tarifa, así que va escrito en la hoja
// para que la cifra se pueda cuadrar.

const NIVEL_COMISIONISTA: NivelCascada = {
  nombre: "Comisionista",
  clave: (f) => f.comisionista,
  etiqueta: (f) => f.comisionista ?? "",
  vacio: "Sin comisionista asignado"
};

const NIVEL_DIVISION: NivelCascada = {
  nombre: "División",
  clave: (f) => f.division_code,
  etiqueta: (f) => f.division ?? f.division_code ?? "",
  vacio: "Sin división"
};

const NIVEL_CEDIS: NivelCascada = {
  nombre: "CEDIS",
  clave: (f) => f.cedis,
  etiqueta: (f) => f.cedis ?? "",
  vacio: "Sin CEDIS asignado"
};

export const NIVELES_POR_COMISIONISTA: NivelCascada[] = [NIVEL_COMISIONISTA, NIVEL_DIVISION];

export const NIVELES_POR_DIVISION: NivelCascada[] = [NIVEL_DIVISION, NIVEL_CEDIS, NIVEL_COMISIONISTA];
