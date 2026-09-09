"use client";

// Módulo 1 · Comisiones — conectada de verdad a POST /api/comisionesbi/report.
//
// Estuvo devolviendo 501 con una vista previa de ejemplo al lado hasta que el
// cliente mandó los SETs y las tarifas el 24 de agosto de 2026. Ya no hay datos
// de ejemplo en este fichero: lo que se ve es lo que hay.
//
// LA DECISIÓN QUE MANDA SOBRE TODA LA PANTALLA: todavía no se calcula comisión
// sobre todo el facturado, así que el total de arriba NO es el total. La
// pregunta que tiene que poder contestar cualquiera que abra esto es "¿esto está
// completo?", y se contesta en dos sitios sin pulsar nada:
//
//   · el embudo de la cabecera, donde se ve el salto de "facturado en alcance" a
//     "con tarifa aplicable" con su porcentaje;
//   · el rótulo del desplegable del final, que dice cuánto dinero se queda fuera
//     aunque esté cerrado.
//
// Lo que se pliega es el DESGLOSE POR MOTIVO, no el hecho de que falte dinero.
// Esa distinción es la que hay que respetar si alguien reorganiza esto: el
// importe bloqueado puede cambiar de sitio, pero no puede desaparecer de la
// primera lectura.
//
// (Antes ese bloque iba desplegado y en medio de la pantalla, cuando lo que
// faltaba eran $174 M de botana pendientes de saber qué hoja de tarifas valía.
// Eso se resolvió el 26/08/2026 —`Sheet1`, confirmado por Diego— y lo que queda
// bloqueado es más pequeño y menos urgente, así que ya no se lleva media
// pantalla.)

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { AvisoBoton, Modal } from "@/components/aviso";
import { FiltersSidebar } from "@/components/filters-sidebar";
// Las piezas y la paleta salen de flujo de producto en vez de duplicarse: las
// dos pantallas tienen que verse como la misma herramienta, y los colores de
// `fases.ts` están validados contra la guía de visualización (contraste,
// daltonismo). Inventar aquí un verde nuevo sería empezar a tener dos pieles.
import { Donut, type SegmentoDato } from "@/features/flujo-producto/flujo-piezas";
import { COLOR_FASE, COLOR_SIN_ASIGNAR, PALETA_CATEGORIAS } from "@/features/flujo-producto/fases";
import { BarrasVerticales, type BarraVertical } from "@/features/comisiones/comisiones-barras";
import {
  ComisionesCascada,
  jerarquia,
  NIVELES_POR_COMISIONISTA,
  NIVELES_POR_DIVISION
} from "@/features/comisiones/comisiones-cascada";
import type {
  CedisRow,
  ComisionesCatalog,
  DivisionRow,
  ReportFilters,
  ReportResponse
} from "@/types/comisiones";

/** Lo que define una consulta. Se pasa entero a `load` para que un clic pueda
 *  cambiar una pieza sin esperar a que React actualice el estado. */
type Filtros = {
  division: string;
  sociedad: string;
  cedis: string;
  comisionista: string;
  desde: string;
  hasta: string;
};

type Props = {
  initialCatalog: ComisionesCatalog;
  initialError: string | null;
  initialReport: ReportResponse | null;
  rangoInicial: { desde: string; hasta: string };
};

const dinero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const numero = new Intl.NumberFormat("es-MX");
const decimal = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 });
const fechaLarga = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric" });
const mesCorto = new Intl.DateTimeFormat("es-MX", { month: "short", year: "numeric" });
const soloMes = new Intl.DateTimeFormat("es-MX", { month: "short" });

/** El azul de marca de las barras de este skin. La comisión es la medida
 *  principal de la pantalla, así que lleva el color principal; lo facturado
 *  usa el verde de la fase "facturado" del flujo, que es de donde sale. */
const COLOR_COMISION = "#3d3d7c";

/** Barras de CEDIS que se dibujan antes de mandar la cola a la tabla. */
const TOPE_CEDIS = 8;

// Los dos motivos de "bloqueado" con detalle disponible en `bloqueado_desglose`
// (ver comisiones_engine.py). Cada uno se lee por una llave distinta -- por
// eso el modal que los muestra tiene columnas distintas, no las mismas dos.
const MOTIVO_SIN_TARIFA = "sin tarifa para esa llave";
const MOTIVO_SIN_CEDIS = "sin CEDIS/tipo de venta";

/** "2026-01-02" -> "2 de enero de 2026", sin que el huso horario reste un día.
 *  `new Date("2026-01-02")` se interpreta como UTC y al formatearlo en México
 *  sale el 1 de enero. Construyéndola por partes se queda en local. */
function enPalabras(iso: string | undefined | null) {
  if (!iso) return null;
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) return null;
  return fechaLarga.format(new Date(a, m - 1, d));
}

function pesos(valor: number) {
  return `$${dinero.format(valor)}`;
}

function pct(parte: number, total: number) {
  return total ? `${decimal.format((parte / total) * 100)}%` : "—";
}

/** "2026-01" -> "ene", o "ene 2026" si la serie cruza de año. Se construye por
 *  partes para no perder un día al huso horario, y se quita el año cuando es el
 *  mismo en toda la serie: ocho barras repitiendo "2026" no informan de nada y
 *  el rótulo deja de caber bajo su barra. */
function etiquetaMes(mes: string, conAnio: boolean) {
  const [a, m] = mes.split("-").map(Number);
  const formato = conAnio ? mesCorto : soloMes;
  return formato.format(new Date(a, m - 1, 1));
}

/** Recorta un nombre largo dejando rastro de que está recortado. Los rótulos de
 *  CEDIS van girados bajo su barra: sin tope, uno largo se sale de la tarjeta.
 *  El nombre completo sigue en el tooltip. */
function recortar(texto: string, tope = 14) {
  return texto.length > tope ? `${texto.slice(0, tope - 1)}…` : texto;
}

/** Primer y último día de un mes "2026-02", sin depender del huso: `Date.UTC`
 *  con día 0 del mes siguiente da el último día del mes pedido. */
function limitesDelMes(mes: string): { desde: string; hasta: string } {
  const [anio, m] = mes.split("-").map(Number);
  return {
    desde: `${mes}-01`,
    hasta: new Date(Date.UTC(anio, m, 0)).toISOString().slice(0, 10)
  };
}

/**
 * Un paso del embudo. `grupo` NO es decorativo: los dos primeros pasos son
 * pesos facturados y los dos últimos pesos de comisión, que es el 2-3% de los
 * primeros. Con una sola escala, las barras de comisión serían dos rayas
 * invisibles y el embudo diría "aquí no queda nada", que es falso. Cada grupo
 * escala contra su propio primer paso, y el corte se marca en la pantalla.
 */
type PasoEmbudo = {
  clave: string;
  etiqueta: string;
  valor: number;
  ancho: number;
  color: string;
  grupo: "facturado" | "comision";
  /** Lo que se lee sobre la flecha que llega a este paso. */
  conector: string | null;
  nota?: string;
};

function divisionLabel(row: DivisionRow): string {
  const candidate = row.business_area_name;
  return candidate === null || candidate === undefined ? JSON.stringify(row) : String(candidate);
}

export function ComisionesWorkspace({ initialCatalog, initialError, initialReport, rangoInicial }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [division, setDivision] = useState("");
  const [cedis, setCedis] = useState("");
  const [comisionista, setComisionista] = useState("");
  const [sociedad, setSociedad] = useState("");
  const [desde, setDesde] = useState(rangoInicial.desde);
  const [hasta, setHasta] = useState(rangoInicial.hasta);
  const [report, setReport] = useState(initialReport);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  // Qué motivo de "lo que todavía no entra en el cálculo" está abierto en el
  // modal de detalle. `null` = cerrado.
  const [motivoDetalle, setMotivoDetalle] = useState<string | null>(null);

  /**
   * `cambios` existe porque ahora se filtra también pulsando una barra, y
   * `setCedis(x)` seguido de `load()` recalcularía con el CEDIS ANTERIOR: el
   * estado de React no ha cambiado todavía cuando `load` lee sus variables. El
   * clic pasa aquí lo que acaba de elegir y el estado se actualiza en paralelo
   * para que el panel lateral lo refleje.
   */
  async function load(cambios: Partial<Filtros> = {}) {
    const f: Filtros = { division, cedis, comisionista, sociedad, desde, hasta, ...cambios };
    setLoading(true);
    setError(null);
    try {
      const body: ReportFilters = {
        division: f.division || null,
        cedis: f.cedis || null,
        comisionista: f.comisionista || null,
        sociedad: f.sociedad || null,
        start_date: f.desde,
        end_date: f.hasta
      };
      const response = await fetch("/api/comisionesbi/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as (ReportResponse & { detail?: string }) | null;
      if (!response.ok) {
        throw new Error(payload?.detail || "No se pudo generar el informe de comisión.");
      }
      setReport(payload as ReportResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el informe de comisión.");
    } finally {
      setLoading(false);
    }
  }

  const activeFilterCount = [division, cedis, comisionista, sociedad].filter(Boolean).length;
  // Pedir hasta hoy cuando los datos acaban el 23 de agosto no es un error, pero
  // deja creer que el último tramo no vendió nada. Se dice, en vez de que cada
  // uno lo descubra por su cuenta.
  const corte = report?.cobertura?.hasta;
  const seVaDeRango = Boolean(corte && hasta > corte);
  const totales = report?.totales;
  const bloqueado = report?.bloqueado ?? [];
  const montoBloqueado = bloqueado.reduce((suma, b) => suma + b.monto, 0);
  // La horquilla solo existe donde las dos hojas del cliente se contradicen.
  const horquilla = bloqueado.reduce((suma, b) => suma + (b.comision_max - b.comision_min), 0);
  const bloqueadoDesglose = report?.bloqueado_desglose ?? [];
  // "sin tarifa para esa llave": la llave es sociedad+división+oficina+SET+
  // tipo de venta, tal cual la manda el backend -- una fila por combinación.
  const detalleSinTarifa = useMemo(
    () => bloqueadoDesglose.filter((d) => d.motivo === MOTIVO_SIN_TARIFA),
    [bloqueadoDesglose]
  );
  // "sin CEDIS/tipo de venta": la llave es almacén+oficina, no SET+tipo de
  // venta (que ahí es justo lo que falta). El backend manda el mismo grano de
  // siempre (con sociedad/SET incluidos), así que se reagrupa aquí -- sin
  // eso, la misma combinación almacén+oficina aparecería repetida por cada
  // SET/sociedad que le tocó, igual que la tabla que ya se armó a mano.
  const detalleSinCedis = useMemo(() => {
    const acumulado = new Map<
      string,
      { division: string | null; division_code: string | null; oficina: string | null; almacen: string | null; num_lineas: number; monto: number }
    >();
    for (const d of bloqueadoDesglose) {
      if (d.motivo !== MOTIVO_SIN_CEDIS) continue;
      const clave = `${d.division_code}|${d.oficina}|${d.almacen}`;
      const actual = acumulado.get(clave) ?? {
        division: d.division,
        division_code: d.division_code,
        oficina: d.oficina,
        almacen: d.almacen,
        num_lineas: 0,
        monto: 0
      };
      actual.num_lineas += d.num_lineas;
      actual.monto += d.monto;
      acumulado.set(clave, actual);
    }
    return Array.from(acumulado.values()).sort((a, b) => b.monto - a.monto);
  }, [bloqueadoDesglose]);
  const detalleDelMotivo = motivoDetalle === MOTIVO_SIN_CEDIS ? detalleSinCedis : detalleSinTarifa;

  // Comisionistas a los que hay algo que pagarles. Ni el total de la tabla (que
  // incluye a quien devengó cero) ni el del catálogo del cliente (57 nombres,
  // muchos sin venta en el periodo): los que salen en la liquidación de ESTE
  // periodo. El grupo sin nombre no cuenta, porque no se le puede pagar.
  const comisionistas = (report?.por_comisionista ?? []).filter(
    (f) => f.comisionista && f.comision > 0
  ).length;

  /** Los cuatro pasos, con el corte de unidad entre el segundo y el tercero. */
  const embudo: PasoEmbudo[] = useMemo(() => {
    if (!totales) return [];
    const { monto, monto_calculable, comision, comision_con_cobro } = totales;
    return [
      {
        clave: "facturado",
        etiqueta: "Facturado en alcance",
        valor: monto,
        ancho: 100,
        color: COLOR_FASE.facturado,
        grupo: "facturado",
        conector: null
      },
      {
        clave: "con-tarifa",
        etiqueta: "Con tarifa aplicable",
        valor: monto_calculable,
        ancho: monto ? (monto_calculable / monto) * 100 : 0,
        color: COLOR_FASE.facturado,
        grupo: "facturado",
        conector: pct(monto_calculable, monto)
      },
      {
        clave: "devengada",
        etiqueta: "Comisión sobre facturación",
        valor: comision,
        ancho: 100,
        color: COLOR_COMISION,
        grupo: "comision",
        // Sin porcentaje a propósito: sería la tasa efectiva, y no es
        // comparable de un periodo a otro porque cambia con la mezcla de
        // divisiones (huevo se comisiona por kilo, abarrotes por margen).
        conector: "genera"
      },
      {
        clave: "con-cobro",
        etiqueta: "Comisión sobre cobro",
        valor: comision_con_cobro,
        ancho: comision ? (comision_con_cobro / comision) * 100 : 0,
        color: COLOR_COMISION,
        grupo: "comision",
        conector: pct(comision_con_cobro, comision),
        nota: "suelo conocido, no lo pagable"
      }
    ];
  }, [totales]);

  // Recortado a las primeras posiciones: dieciocho barras verticales con nombre
  // debajo no se leen, y la cola entera está en la tabla por comisionista y en
  // el propio filtro de CEDIS del panel.
  const barrasCedis: BarraVertical[] = useMemo(
    () =>
      (report?.por_cedis ?? [])
        .filter((fila) => fila.comision > 0)
        .slice(0, TOPE_CEDIS)
        .map((fila) => ({
          nombre: fila.cedis ?? "Sin CEDIS asignado",
          valor: fila.cedis,
          etiqueta: fila.cedis === null ? "Sin CEDIS" : recortar(fila.cedis),
          cantidad: fila.comision,
          // El grupo sin CEDIS no es un CEDIS más: va en naranja y no se pulsa,
          // igual que en flujo de producto.
          color: fila.cedis === null ? COLOR_SIN_ASIGNAR : undefined
        })),
    [report?.por_cedis]
  );

  const cedisOcultos = Math.max(0, (report?.por_cedis ?? []).filter((f) => f.comision > 0).length - TOPE_CEDIS);

  const barrasMes: BarraVertical[] = useMemo(() => {
    const acumulado = new Map<string, number>();
    for (const fila of report?.por_fecha ?? []) {
      const mes = fila.fecha.slice(0, 7);
      acumulado.set(mes, (acumulado.get(mes) ?? 0) + fila.comision);
    }
    const conAnio = new Set(Array.from(acumulado.keys(), (mes) => mes.slice(0, 4))).size > 1;
    // Cronológico, no por importe: es una serie, y ordenada por tamaño no se
    // puede leer una tendencia.
    return Array.from(acumulado.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mes, cantidad]) => ({ valor: mes, etiqueta: etiquetaMes(mes, conAnio), cantidad }));
  }, [report?.por_fecha]);

  // El color se asigna por orden alfabético fijo de la categoría, nunca por
  // posición en el ranking: si no, filtrar repintaría a los supervivientes.
  const segmentosTipoVenta: SegmentoDato[] = useMemo(() => {
    const filas = (report?.por_tipo_venta ?? []).filter((fila) => fila.comision > 0);
    const claves = filas
      .map((fila) => fila.tipo_venta)
      .filter((c): c is string => c !== null)
      .sort();
    return filas.map((fila) => ({
      valor: fila.tipo_venta,
      etiqueta: fila.tipo_venta ?? "Sin tipo de venta",
      cantidad: fila.comision,
      color:
        fila.tipo_venta === null
          ? COLOR_SIN_ASIGNAR
          : PALETA_CATEGORIAS[claves.indexOf(fila.tipo_venta) % PALETA_CATEGORIAS.length]
    }));
  }, [report?.por_tipo_venta]);

  /** Pulsar un CEDIS lo pone en el filtro y recalcula; volver a pulsarlo lo quita. */
  function filtrarPorCedis(valor: string) {
    const elegido = valor === cedis ? "" : valor;
    setCedis(elegido);
    void load({ cedis: elegido });
  }

  /** Pulsar un mes acota el periodo a ese mes. No se deshace volviendo a
   *  pulsarlo —para eso está el rango del panel—, igual que en flujo. */
  function irAlMes(mes: string) {
    const limites = limitesDelMes(mes);
    setDesde(limites.desde);
    setHasta(limites.hasta);
    void load(limites);
  }

  const mesActivo = desde.slice(0, 7) === hasta.slice(0, 7) ? desde.slice(0, 7) : null;

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={activeFilterCount}
        info={
          <>
            <p>
              Comisión devengada por comisionista, calculada línea a línea sobre lo{" "}
              <b>facturado</b>.
            </p>
            <h3>Por qué sobre lo facturado, si se paga sobre lo cobrado</h3>
            <p>
              Porque lo cobrado no trae material: <code>sap_bsad_cleared_items</code> da una fila por
              factura, sin línea, así que no hay SET ni tarifa posible. Esa fuente ve ~87% de lo
              facturado; el resto es cartera aún no cobrada (concentrada en los últimos dos meses),
              no un problema de la fuente.
            </p>
            <p>
              Por eso la columna «con cobro registrado» es un <b>suelo conocido</b>, no lo que hay
              que pagar.
            </p>
          </>
        }
        infoTitle="Comisiones"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={report?.cobertura?.hasta ?? null}
      >
        <label>
          División
          <select onChange={(e) => setDivision(e.target.value)} value={division}>
            <option value="">Todas</option>
            {initialCatalog.divisiones.map((row, index) => (
              <option key={index} value={divisionLabel(row)}>
                {divisionLabel(row)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sociedad
          <select onChange={(e) => setSociedad(e.target.value)} value={sociedad}>
            <option value="">Todas</option>
            {(report?.por_sociedad ?? [])
              .map((f) => f.sociedad)
              .filter((n): n is string => Boolean(n))
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
        <label>
          CEDIS
          <select onChange={(e) => setCedis(e.target.value)} value={cedis}>
            <option value="">Todos</option>
            {Array.from(new Set(initialCatalog.cedis.map((row: CedisRow) => row.cedis))).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Comisionista
          <select onChange={(e) => setComisionista(e.target.value)} value={comisionista}>
            <option value="">Todos</option>
            {(report?.por_comisionista ?? [])
              .map((f) => f.comisionista)
              .filter((n): n is string => Boolean(n))
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
        <label>
          Desde
          <input onChange={(e) => setDesde(e.target.value)} type="date" value={desde} />
        </label>
        <label>
          Hasta
          <input onChange={(e) => setHasta(e.target.value)} type="date" value={hasta} />
        </label>
        <p className="flujo-pista">
          El CEDIS y el mes también se eligen pulsando sobre las barras de la pantalla.
        </p>
        <div className="filters-sidebar-actions">
          <button className="hydro-button" disabled={loading} onClick={() => void load()} type="button">
            {loading ? "Calculando…" : "Calcular"}
          </button>
          <button
            className="hydro-link-button"
            onClick={() => {
              setDivision("");
              setCedis("");
              setComisionista("");
              setDesde(rangoInicial.desde);
              setHasta(rangoInicial.hasta);
            }}
            type="button"
          >
            Restablecer
          </button>
        </div>
      </FiltersSidebar>

      <div className="hydro-page comisiones-pagina" data-module="comisiones">
        {error ? <p className="hydro-error">{error}</p> : null}

        <header className="operational-summary comisiones-cabecera">
          <div className="operational-summary-title">
            <p>Cálculo de comisión</p>
            <h1>Comisiones</h1>
            <span>
              Comisión devengada por comisionista, sobre lo facturado. Huevo se comisiona por kilo;
              botana, croqueta y leche por unidad.
            </span>
            {/* El periodo se elegía en el panel de filtros, que arranca cerrado, así
                que la pantalla enseñaba cifras sin decir de cuándo eran. Va aquí
                arriba y siempre visible: un importe de comisión sin su periodo no
                significa nada. */}
            <div className="periodo-activo">
              <span>
                Del <b>{enPalabras(desde) ?? desde}</b> al <b>{enPalabras(hasta) ?? hasta}</b>
              </span>
              {/* El mismo icono y el mismo modal que en flujo de producto: un
                  aviso sobre los datos se lee igual en las dos pantallas. */}
              {seVaDeRango ? (
                <AvisoBoton
                  tono="dato"
                  titulo="El periodo pedido va más allá de los datos cargados"
                >
                  <p>
                    Hay facturación cargada hasta el <b>{enPalabras(corte)}</b>. El periodo que estás
                    viendo llega hasta el <b>{enPalabras(hasta) ?? hasta}</b>, así que los últimos
                    días salen en blanco.
                  </p>
                  <p>
                    <b>No es que no se facturara</b>: es que el dato todavía no está. Viene de la
                    ingesta de SAP, que es compartida con el resto del grupo y ajena a esta
                    herramienta.
                  </p>
                  <p>
                    Mientras dure, no leas la caída del final como una bajada de ventas ni de
                    comisión. El mismo aviso está en la pantalla de{" "}
                    <Link href="/flujo-producto">flujo de producto</Link>, donde se ve el efecto
                    sobre la serie diaria.
                  </p>
                </AvisoBoton>
              ) : null}
            </div>
          </div>
          {/* Un solo número grande en vez de la fila de cuatro indicadores que
              había antes. Los otros tres eran los pasos del embudo de abajo
              escritos como cifras sueltas —facturado, con tarifa, con cobro—,
              así que se decían dos veces y en ningún sitio se veía cómo se
              relacionan. El cuarto era un conteo de líneas, que no es una
              respuesta a ninguna pregunta. */}
          {totales ? (
            <div className="comisiones-titular">
              <span>Comisión devengada</span>
              <strong>{pesos(totales.comision)}</strong>
              <small>
                {numero.format(comisionistas)} comisionistas ·{" "}
                {numero.format(totales.num_lineas)} líneas
              </small>
            </div>
          ) : null}
        </header>

        {/* ── Embudo ──────────────────────────────────────────────────────
            De lo facturado a lo que se puede cobrar, en los cuatro pasos que
            de verdad tiene el cálculo. La escala se rompe a propósito entre el
            segundo y el tercero: ver `PasoEmbudo`. */}
        {embudo.length ? (
          <section className="comisiones-embudo" aria-label="Del facturado a la comisión">
            <div className="comisiones-embudo-pasos">
              {embudo.map((paso, indice) => (
                <Fragment key={paso.clave}>
                  {paso.conector ? (
                    <div
                      className="comisiones-embudo-flecha"
                      data-corte={embudo[indice - 1]?.grupo !== paso.grupo ? "si" : undefined}
                    >
                      <span>{paso.conector}</span>
                    </div>
                  ) : null}
                  <div className="comisiones-embudo-paso" data-grupo={paso.grupo}>
                    <span className="comisiones-embudo-etiqueta">{paso.etiqueta}</span>
                    <strong>{pesos(paso.valor)}</strong>
                    <span className="comisiones-embudo-barra">
                      <i style={{ background: paso.color, width: `${Math.max(1.5, paso.ancho)}%` }} />
                    </span>
                    {paso.nota ? <em>{paso.nota}</em> : null}
                  </div>
                </Fragment>
              ))}
            </div>
            <p className="comisiones-embudo-pie">
              Los dos primeros pasos son pesos <b>facturados</b>; los dos últimos, pesos de{" "}
              <b>comisión</b>, que son un 2-3% de los primeros. Cada mitad se dibuja a su propia
              escala — comparar el largo de una barra verde con una azul no significa nada.
            </p>
          </section>
        ) : null}

        {/* ── Tablero ─────────────────────────────────────────────────────
            Tres gráficos en una fila. El CEDIS es el eje del proyecto y va el
            más ancho; el mes contesta "cuánto llevamos este mes"; el tipo de
            venta lo pide el objetivo ("el monto a pagar según tipo de venta"). */}
        {report ? (
          <div className="comisiones-tablero">
            <section className="dashboard-card" data-zona="mes">
              <div className="dashboard-card-head">
                <div>
                  <h2>Comisión por mes</h2>
                  <span>
                    pulsa un mes para acotar el periodo
                    {mesActivo ? " · viendo un mes suelto, la serie es de uno" : null}
                  </span>
                </div>
              </div>
              <BarrasVerticales
                color={COLOR_COMISION}
                datos={barrasMes}
                onSelect={irAlMes}
                seleccion={mesActivo}
                titulo={(dato, activa) =>
                  activa
                    ? `Ya estás viendo ${dato.etiqueta}`
                    : `Acotar el periodo a ${dato.etiqueta} · ${pesos(dato.cantidad)}`
                }
                vacio="Sin comisión en el periodo"
              />
            </section>

            <section className="dashboard-card" data-zona="cedis">
              <div className="dashboard-card-head">
                <div>
                  <h2>Comisión por CEDIS</h2>
                  <span>
                    pulsa uno para filtrar toda la pantalla
                    {cedisOcultos > 0 ? ` · los ${TOPE_CEDIS} primeros de ${TOPE_CEDIS + cedisOcultos}` : null}
                  </span>
                </div>
              </div>
              <BarrasVerticales
                color={COLOR_COMISION}
                datos={barrasCedis}
                onSelect={filtrarPorCedis}
                rotulosGirados
                seleccion={cedis || null}
                titulo={(dato, activa) => {
                  // El nombre entero viaja en el propio dato: buscarlo por el
                  // rótulo fallaba justo con los nombres que se recortan, que
                  // son los que lo necesitan.
                  const nombre = dato.nombre ?? dato.etiqueta;
                  if (dato.valor === null) return `Sin CEDIS asignado · ${pesos(dato.cantidad)}`;
                  return activa
                    ? `Quitar el filtro de ${nombre}`
                    : `Filtrar por ${nombre} · ${pesos(dato.cantidad)}`;
                }}
                vacio="Ningún CEDIS devengó comisión en el periodo"
              />
            </section>

            <section className="dashboard-card" data-zona="tipo">
              <div className="dashboard-card-head">
                <div>
                  {/* Sin "pulsa para filtrar": el endpoint de comisión no tiene
                      filtro de tipo de venta, así que este donut se lee, no se
                      pulsa. Por eso va `estatico`. */}
                  <h2>Por tipo de venta</h2>
                  <span>solo lectura</span>
                </div>
              </div>
              <Donut
                datos={segmentosTipoVenta}
                estatico
                leyendaTotal="tipos"
                metrica="importe"
                onSelect={() => undefined}
                seleccion={null}
              />
            </section>
          </div>
        ) : null}

        {report?.desglose.length ? (
          <section className="hydro-table-card">
            <div className="hydro-table-title">
              <div>
                {/* La jerarquía va en el título y sale de los propios niveles:
                    escrita a mano podría decir una cosa y la tabla hacer otra. */}
                <h2>
                  Comisión por comisionista{" "}
                  <span className="cascada-jerarquia">({jerarquia(NIVELES_POR_COMISIONISTA)})</span>
                </h2>
                <span>
                  {numero.format(comisionistas)} comisionistas · pulsa <b>+</b> para bajar un nivel
                </span>
              </div>
            </div>
            {/* El CEDIS va como columna y no como nivel: un comisionista trabaja
                normalmente en uno, así que ese nivel sería un clic para llegar a
                un único hijo. */}
            <ComisionesCascada
              columnaCedis
              encabezado="Comisionista"
              filas={report.desglose}
              niveles={NIVELES_POR_COMISIONISTA}
            />
          </section>
        ) : null}

        {report?.desglose.length ? (
          <section className="hydro-table-card">
            <div className="hydro-table-title">
              <div>
                <h2>
                  Comisión por división{" "}
                  <span className="cascada-jerarquia">({jerarquia(NIVELES_POR_DIVISION)})</span>
                </h2>
                <span>
                  La columna «con tarifa» dice qué parte del facturado llegó a tener una, no sobre el
                  total
                </span>
              </div>
            </div>
            <ComisionesCascada
              encabezado="División"
              filas={report.desglose}
              niveles={NIVELES_POR_DIVISION}
            />
          </section>
        ) : null}

        {totales?.lineas_sin_importe ? (
          <p className="hydro-nota">
            {numero.format(totales.lineas_sin_importe)} líneas del periodo tienen cantidad entregada
            e importe cero. Se comisionan porque hay producto entregado, y quedan marcadas por si el
            cliente decide que no deberían.
          </p>
        ) : null}

        {/* Al final de la página y plegado, pero CON SU CIFRA EN EL RÓTULO: lo
            que se pliega es el desglose por motivo, no el hecho de que falte
            dinero por entrar. Cerrado sigue diciendo cuánto es, así que la
            pregunta "¿esto está completo?" se contesta sin pulsar nada. */}
        {bloqueado.length ? (
          <details className="comisiones-plegable">
            <summary>
              <span className="comisiones-plegable-titulo">Lo que todavía no entra en el cálculo</span>
              <span className="comisiones-plegable-cifra">
                {pesos(montoBloqueado)} facturados sin comisión aplicable
                {horquilla > 0 ? ` · ${pesos(horquilla)} dependen de qué hoja de tarifas valga` : null}
              </span>
            </summary>
            <div className="hydro-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Motivo</th>
                    <th className="n">Líneas</th>
                    <th className="n">Facturado</th>
                    <th className="n">Comisión si entrara</th>
                  </tr>
                </thead>
                <tbody>
                  {bloqueado.map((b) => {
                    const clicable = b.motivo === MOTIVO_SIN_TARIFA || b.motivo === MOTIVO_SIN_CEDIS;
                    return (
                      <tr
                        className={clicable ? "comisiones-bloqueado-clicable" : undefined}
                        key={b.motivo}
                        onClick={clicable ? () => setMotivoDetalle(b.motivo) : undefined}
                        onKeyDown={
                          clicable
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setMotivoDetalle(b.motivo);
                                }
                              }
                            : undefined
                        }
                        tabIndex={clicable ? 0 : undefined}
                        title={
                          clicable
                            ? b.motivo === MOTIVO_SIN_TARIFA
                              ? "Ver el detalle por división, oficina, SET y tipo de venta"
                              : "Ver el detalle por división, oficina y almacén"
                            : undefined
                        }
                      >
                        <td>
                          {b.motivo}
                          {clicable ? <span className="comisiones-bloqueado-ver-detalle"> — ver detalle →</span> : null}
                        </td>
                        <td className="n">{numero.format(b.num_lineas)}</td>
                        <td className="n">{pesos(b.monto)}</td>
                        <td className="n">
                          {/* Donde hay conflicto de tarifas se sabe el rango; en el
                              resto todavía no se sabe nada, y decirlo es más útil
                              que un cero que parece una cifra. */}
                          {b.comision_max > 0
                            ? `${pesos(b.comision_min)} – ${pesos(b.comision_max)}`
                            : "sin determinar"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}

        {motivoDetalle ? (
          <Modal
            onClose={() => setMotivoDetalle(null)}
            subtitulo={`${numero.format(detalleDelMotivo.reduce((s, d) => s + d.num_lineas, 0))} líneas · ${pesos(
              detalleDelMotivo.reduce((s, d) => s + d.monto, 0)
            )} facturados`}
            titulo={motivoDetalle}
          >
            <table>
              {motivoDetalle === MOTIVO_SIN_CEDIS ? (
                <>
                  <thead>
                    <tr>
                      <th>División</th>
                      <th>Oficina</th>
                      <th>Almacén</th>
                      <th className="n">Líneas</th>
                      <th className="n">Facturado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalleSinCedis.map((d, indice) => (
                      <tr key={indice}>
                        <td>{d.division ?? d.division_code ?? "—"}</td>
                        <td>{d.oficina ?? "—"}</td>
                        <td>{d.almacen ?? "—"}</td>
                        <td className="n">{numero.format(d.num_lineas)}</td>
                        <td className="n">{pesos(d.monto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr>
                      <th>Sociedad</th>
                      <th>División</th>
                      <th>Oficina</th>
                      <th>SET</th>
                      <th>Tipo de venta</th>
                      <th className="n">Líneas</th>
                      <th className="n">Facturado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalleSinTarifa.map((d, indice) => (
                      <tr key={indice}>
                        <td>{d.sociedad ?? "—"}</td>
                        <td>{d.division ?? d.division_code ?? "—"}</td>
                        <td>{d.oficina ?? "—"}</td>
                        <td>{d.set ?? "—"}</td>
                        <td>{d.tipo_venta ?? "—"}</td>
                        <td className="n">{numero.format(d.num_lineas)}</td>
                        <td className="n">{pesos(d.monto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </Modal>
        ) : null}
      </div>
    </div>
  );
}
