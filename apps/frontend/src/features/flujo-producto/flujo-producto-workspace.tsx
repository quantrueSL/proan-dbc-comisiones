"use client";

// Módulo 0 · Flujo de producto — vendido, facturado y cobrado por CEDIS.
// Datos de ZZ_PRUEBAS.DBC_gold_flujo_producto_diario (ver flujo_engine.py).
//
// La pantalla es de gráficas, no de tablas: las tablas están detrás de botones
// porque casi nadie las mira y apiladas tapaban lo que sí se mira. Pulsar una
// barra filtra TODA la pantalla — el filtro va a la URL y lo recalcula el
// servidor, así que el estado es compartible y no hay dos verdades.
//
// CÓMO SE REPARTE EL SITIO (lo que se rehízo, y por qué):
//   · Un ancho máximo. Sin él, en un monitor ancho los tres indicadores se
//     estiraban a 600 px cada uno —el número quedaba a un palmo de su rótulo—
//     y las cinco tarjetas se ponían en fila, cada una demasiado estrecha para
//     leer el nombre de un CEDIS.
//   · Una sola fila de controles: métrica, filtros activos, avisos y el menú de
//     tablas. Antes eran dos filas y media.
//   · Tablero de dos columnas anchas (CEDIS y división, que son listas largas)
//     más una columna estrecha con las tres piezas pequeñas. Las listas se
//     recortan a las primeras posiciones; la cola se ve en la tabla.
//
// DOS COSAS QUE NO PUEDE HACER, y no son cosméticas:
//   1. Ocultar el grupo sin CEDIS asignado. Es dos tercios del importe
//      (data/notas/08): escondido, los totales no cuadrarían y nadie sabría
//      por qué. Se pinta en naranja y no es pulsable, porque no es un CEDIS.
//   2. Sumar cantidades entre unidades distintas (CS, PZA, PAQ, SAC, KG).

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiltersSidebar } from "@/components/filters-sidebar";
import { FlujoChart } from "@/features/flujo-producto/flujo-chart";
import {
  COLOR_FASE,
  COLOR_SIN_ASIGNAR,
  ETIQUETA_FASE,
  FASES,
  PALETA_CATEGORIAS
} from "@/features/flujo-producto/fases";
import {
  AvisoBoton,
  Donut,
  MetricToggle,
  Modal,
  RankedBars,
  formatearMetrica,
  type BarraDato,
  type Metrica,
  type SegmentoDato
} from "@/features/flujo-producto/flujo-piezas";
import type {
  CedisRow,
  ComisionesCatalog,
  FlujoResponse,
  FlujoTotales
} from "@/types/comisiones";

type Filtros = {
  desde: string;
  hasta: string;
  division: string | null;
  cedis: string | null;
  tipoVenta: string | null;
};

type Props = {
  initialCatalog: ComisionesCatalog;
  initialFlujo: FlujoResponse;
  initialError: string | null;
  filtros: Filtros;
};

const numero = new Intl.NumberFormat("es-MX");

type Tabla = "cedis" | "division" | "unidades" | "catalogo";

/** Posiciones que se enseñan en cada tarjeta antes de mandar a la tabla. */
const TOPE_LISTA = 8;

function valorDe(totales: FlujoTotales | undefined, metrica: Metrica): number {
  if (!totales) return 0;
  if (metrica === "importe") return totales.monto_total;
  if (metrica === "lineas") return totales.num_lineas;
  return totales.cantidad_cajas_total ?? 0;
}

/** Agrupa filas {clave, fase, totales} en una fila por clave con las 3 fases. */
function pivotar<T extends { fase: string } & FlujoTotales>(
  filas: T[],
  leerClave: (fila: T) => string | null
) {
  const mapa = new Map<string | null, Record<string, FlujoTotales>>();
  for (const fila of filas) {
    const clave = leerClave(fila);
    const actual = mapa.get(clave) ?? {};
    actual[fila.fase] = fila;
    mapa.set(clave, actual);
  }
  return mapa;
}

/** Barras de una dimensión para la fase que se esté mirando. */
function barras(
  mapa: Map<string | null, Record<string, FlujoTotales>>,
  fase: string,
  metrica: Metrica,
  etiquetaNula: string,
  nombre?: (clave: string) => string
): BarraDato[] {
  return Array.from(mapa.entries())
    .map(([clave, porFase]) => ({
      valor: clave,
      etiqueta: clave === null ? etiquetaNula : nombre?.(clave) ?? clave,
      cantidad: valorDe(porFase[fase], metrica)
    }))
    .filter((d) => d.cantidad > 0)
    .sort((a, b) => b.cantidad - a.cantidad);
}

export function FlujoProductoWorkspace({ initialCatalog, initialFlujo, initialError, filtros }: Props) {
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [desde, setDesde] = useState(filtros.desde);
  const [hasta, setHasta] = useState(filtros.hasta);
  const [metrica, setMetrica] = useState<Metrica>("importe");
  // La fase que gobierna las barras. Facturado es la que tiene el importe
  // fiable, así que es el punto de partida razonable.
  const [fase, setFase] = useState<string>("facturado");
  const [tabla, setTabla] = useState<Tabla | null>(null);

  const { cedis } = initialCatalog;
  const { cobertura, resumen, por_cedis, por_division, por_tipo_venta, cantidad_por_unidad } =
    initialFlujo;

  const totales = useMemo(() => Object.fromEntries(resumen.map((r) => [r.fase, r])), [resumen]);
  const hayCajas = resumen.some((r) => r.cantidad_cajas_total !== null);

  const mapaCedis = useMemo(() => pivotar(por_cedis, (f) => f.cedis), [por_cedis]);
  const mapaDivision = useMemo(() => pivotar(por_division, (f) => f.division_code), [por_division]);
  const mapaTipoVenta = useMemo(() => pivotar(por_tipo_venta, (f) => f.tipo_venta), [por_tipo_venta]);

  const nombreDivision = useMemo(() => {
    const nombres = new Map<string, string>();
    for (const fila of por_division) {
      if (fila.division_code && fila.division) nombres.set(fila.division_code, fila.division);
    }
    return nombres;
  }, [por_division]);

  const barrasCedis = useMemo(
    () => barras(mapaCedis, fase, metrica, "Sin asignar"),
    [mapaCedis, fase, metrica]
  );
  const barrasDivision = useMemo(
    () => barras(mapaDivision, fase, metrica, "Sin división", (c) => nombreDivision.get(c) ?? c),
    [mapaDivision, fase, metrica, nombreDivision]
  );
  // Pocas categorías (VTA EN RUTA, MAYOREO, MED MAYOREO, EXTRAS): donut. El
  // color se asigna por orden fijo de la paleta, nunca por posición en el
  // ranking, para que filtrar no repinte a los supervivientes.
  const segmentosTipoVenta: SegmentoDato[] = useMemo(() => {
    const claves = Array.from(mapaTipoVenta.keys())
      .filter((c): c is string => c !== null)
      .sort();
    const color = new Map(claves.map((c, i) => [c, PALETA_CATEGORIAS[i % PALETA_CATEGORIAS.length]]));
    return barras(mapaTipoVenta, fase, metrica, "Sin tipo").map((dato) => ({
      ...dato,
      color: dato.valor === null ? COLOR_SIN_ASIGNAR : color.get(dato.valor) ?? COLOR_SIN_ASIGNAR
    }));
  }, [mapaTipoVenta, fase, metrica]);

  // Cantidades de la fase activa, separadas por unidad. No es filtrable: es
  // informativa, y sobre todo es el recordatorio visual de que CS, PZA, KG y
  // compañía no se pueden sumar entre sí.
  const unidades: BarraDato[] = useMemo(
    () =>
      cantidad_por_unidad
        .filter((fila) => fila.fase === fase)
        .map((fila) => ({ valor: null, etiqueta: fila.unidad, cantidad: fila.cantidad_total }))
        .sort((a, b) => b.cantidad - a.cantidad),
    [cantidad_por_unidad, fase]
  );

  // Serie mensual: pulsando un mes el periodo se ajusta a ese mes.
  const meses = useMemo(() => {
    const acumulado = new Map<string, number>();
    for (const fila of initialFlujo.por_fecha) {
      if (fila.fase !== fase) continue;
      const mes = fila.fecha.slice(0, 7);
      const valor =
        metrica === "importe"
          ? fila.monto_total
          : metrica === "lineas"
            ? fila.num_lineas
            : fila.cantidad_cajas_total ?? 0;
      acumulado.set(mes, (acumulado.get(mes) ?? 0) + valor);
    }
    return Array.from(acumulado.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mes, cantidad]) => ({ valor: mes, etiqueta: mes, cantidad }));
  }, [initialFlujo.por_fecha, fase, metrica]);

  const fasesDesfasadas = FASES.filter((f) => {
    const hastaFase = cobertura[f]?.hasta;
    return hastaFase && hastaFase < hasta;
  });

  const sinAsignar = mapaCedis.get(null);
  const totalFase = valorDe(totales[fase], metrica);
  const pctSinAsignar = totalFase ? (valorDe(sinAsignar?.[fase], metrica) / totalFase) * 100 : 0;

  /** Pulsar un mes acota el periodo a ese mes; volver a pulsarlo no lo deshace,
   *  para eso está el rango del lateral. */
  function irAlMes(mes: string) {
    const inicio = `${mes}-01`;
    const [anio, numero] = mes.split("-").map(Number);
    const fin = new Date(Date.UTC(anio, numero, 0)).toISOString().slice(0, 10);
    const params = new URLSearchParams({ desde: inicio, hasta: fin });
    if (filtros.division) params.set("division", filtros.division);
    if (filtros.cedis) params.set("cedis", filtros.cedis);
    if (filtros.tipoVenta) params.set("tipo_venta", filtros.tipoVenta);
    router.push(`/flujo-producto?${params.toString()}`);
  }

  function navegar(cambios: Partial<Record<"division" | "cedis" | "tipo_venta", string | null>>) {
    const params = new URLSearchParams({ desde, hasta });
    const actual = {
      division: filtros.division,
      cedis: filtros.cedis,
      tipo_venta: filtros.tipoVenta,
      ...cambios
    };
    for (const [clave, valor] of Object.entries(actual)) {
      if (valor) params.set(clave, valor);
    }
    router.push(`/flujo-producto?${params.toString()}`);
  }

  const chips = [
    filtros.division
      ? { clave: "division" as const, texto: `División: ${nombreDivision.get(filtros.division) ?? filtros.division}` }
      : null,
    filtros.cedis ? { clave: "cedis" as const, texto: `CEDIS: ${filtros.cedis}` } : null,
    filtros.tipoVenta ? { clave: "tipo_venta" as const, texto: `Tipo de venta: ${filtros.tipoVenta}` } : null
  ].filter((c): c is { clave: "division" | "cedis" | "tipo_venta"; texto: string } => c !== null);

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={chips.length}
        info={
          <>
            <p>
              Vendido, facturado y cobrado por CEDIS, a partir de la tabla diaria{" "}
              <code>DBC_gold_flujo_producto_diario</code>.
            </p>
            <p>
              Esta pantalla tiene tres cosas que conviene saber antes de sacar conclusiones. Están
              explicadas en el <b>Manual</b>, en la barra de arriba.
            </p>
          </>
        }
        infoTitle="Flujo de producto"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={null}
      >
        <label>
          Desde
          <input onChange={(e) => setDesde(e.target.value)} type="date" value={desde} />
        </label>
        <label>
          Hasta
          <input onChange={(e) => setHasta(e.target.value)} type="date" value={hasta} />
        </label>
        <div className="filters-sidebar-actions">
          <button className="hydro-button" onClick={() => navegar({})} type="button">
            Aplicar periodo
          </button>
        </div>
        <p className="flujo-pista">
          La división, el CEDIS y el tipo de venta se filtran pulsando sobre las barras.
        </p>
      </FiltersSidebar>

      <div className="hydro-page flujo-pagina" data-module="flujo-producto">
        {initialError ? <p className="hydro-error">{initialError}</p> : null}

        <header className="operational-summary flujo-cabecera">
          <div className="operational-summary-title">
            <p>
              {desde} — {hasta}
            </p>
            <h1>Flujo de producto</h1>
            <span>Vendido, facturado y cobrado por CEDIS, división y tipo de venta.</span>
          </div>
          <section className="hydro-module-kpis" aria-label="Indicadores del flujo">
            {FASES.map((f) => {
              const datos = totales[f];
              const activa = f === fase;
              return (
                <button
                  aria-pressed={activa}
                  className={`hydro-kpi flujo-kpi${activa ? " is-active" : ""}`}
                  key={f}
                  onClick={() => setFase(f)}
                  title={`Ver las gráficas de ${ETIQUETA_FASE[f].toLowerCase()}`}
                  type="button"
                >
                  <span>
                    <i style={{ background: COLOR_FASE[f] }} aria-hidden="true" />
                    {ETIQUETA_FASE[f]}
                  </span>
                  <strong>{formatearMetrica(valorDe(datos, metrica), metrica)}</strong>
                  <small>{datos ? `${numero.format(datos.num_lineas)} líneas` : "sin datos"}</small>
                </button>
              );
            })}
          </section>
        </header>

        {/* Una sola fila para todo lo que no es dato: a la izquierda el contexto
            (avisos y filtros puestos), a la derecha las acciones y el selector
            de métrica. */}
        <div className="flujo-controles">
          <div className="flujo-controles-avisos">
            {/* Los avisos, reducidos a su símbolo. Estaban siempre desplegados y
                ocupaban media pantalla; ahora se abren solo si interesan. */}
            {fasesDesfasadas.length ? (
              <AvisoBoton tono="dato" titulo="Hay fases cuyos datos terminan antes del periodo pedido">
                <p>
                  {fasesDesfasadas.map((f) => `${ETIQUETA_FASE[f]}, hasta el ${cobertura[f]?.hasta}`).join("; ")}.
                </p>
                <p>
                  En la gráfica de serie diaria la línea <b>termina ahí en vez de caer a cero</b>: no
                  es que no hubiera movimiento, es que no hay dato. Viene de la ingesta de SAP, que es
                  compartida con el resto del grupo y ajena a esta herramienta.
                </p>
                <p>
                  Mientras dure, no compares esas fases entre sí en las fechas recientes. Está
                  explicado con detalle en el <Link href="/manual">manual de usuario</Link>.
                </p>
              </AvisoBoton>
            ) : null}

            {pctSinAsignar > 0 ? (
              <AvisoBoton
                tono="atencion"
                titulo={`${pctSinAsignar.toFixed(0)}% de ${ETIQUETA_FASE[fase].toLowerCase()} no tiene CEDIS asignado`}
              >
                <p>
                  Son combinaciones de almacén y oficina que no existen en el catálogo{" "}
                  <code>dm_cedis</code>, así que no se pueden atribuir a ningún CEDIS.
                </p>
                <p>
                  Salen como <b>«Sin asignar»</b> en vez de esconderse, para que los totales de las
                  gráficas cuadren con los indicadores de arriba. No es pulsable porque no es un
                  CEDIS: filtrar por él no significaría nada.
                </p>
                <p>
                  No es un caso raro: son pocas operaciones pero muy grandes. Doce combinaciones
                  explican el 86% del hueco y está pendiente de que el cliente las mapee. Ver el{" "}
                  <Link href="/manual">manual de usuario</Link>.
                </p>
              </AvisoBoton>
            ) : null}
          </div>

          {chips.length ? (
            <div className="dashboard-filter-chips">
              {chips.map((chip) => (
                <button key={chip.clave} onClick={() => navegar({ [chip.clave]: null })} type="button">
                  {chip.texto} <span aria-hidden="true">×</span>
                </button>
              ))}
              <button
                className="flujo-chip-limpiar"
                onClick={() => navegar({ division: null, cedis: null, tipo_venta: null })}
                type="button"
              >
                Limpiar
              </button>
            </div>
          ) : (
            <span className="flujo-controles-pista">
              Pulsa una barra o un trozo del donut para filtrar la pantalla.
            </span>
          )}

          <div className="flujo-controles-derecha">
            {/* Un botón por tabla, a la vista: son cuatro y se sabe de un
                vistazo qué hay. Cada uno abre su ventana. */}
            <div className="flujo-botones-tabla">
              <button onClick={() => setTabla("cedis")} type="button">
                Tabla por CEDIS
              </button>
              <button onClick={() => setTabla("division")} type="button">
                Tabla por división
              </button>
              <button onClick={() => setTabla("unidades")} type="button">
                Cantidades por unidad
              </button>
              <button onClick={() => setTabla("catalogo")} type="button">
                Catálogo de CEDIS
              </button>
            </div>

            <MetricToggle cajasDisponibles={hayCajas} metrica={metrica} onChange={setMetrica} />
          </div>
        </div>

        {/* Todo en una rejilla, la gráfica incluida: ocupa dos columnas de tres
            —ancho de gráfica, no de página— y así el donut le acompaña en la
            misma fila y las listas de abajo entran sin bajar la pantalla. */}
        <div className="flujo-tablero">
          <section className="dashboard-card flujo-tarjeta-grafica" data-zona="grafica">
            <div className="dashboard-card-head">
              <div>
                <h2>Importe diario</h2>
                <span>pasa el ratón por la gráfica para ver el detalle de cada día</span>
              </div>
            </div>
            <FlujoChart filas={initialFlujo.por_fecha} metrica={metrica} />
          </section>

          <section className="dashboard-card" data-zona="cedis">
            <div className="dashboard-card-head">
              <div>
                <h2>Por CEDIS</h2>
                <span>{ETIQUETA_FASE[fase]} · pulsa para filtrar</span>
              </div>
            </div>
            <RankedBars
              alVerTodo={() => setTabla("cedis")}
              color={COLOR_FASE[fase]}
              datos={barrasCedis}
              limite={TOPE_LISTA}
              metrica={metrica}
              onSelect={(valor) => navegar({ cedis: valor })}
              seleccion={filtros.cedis}
            />
          </section>

          <section className="dashboard-card" data-zona="division">
            <div className="dashboard-card-head">
              <div>
                <h2>Por división</h2>
                <span>{ETIQUETA_FASE[fase]} · pulsa para filtrar</span>
              </div>
            </div>
            <RankedBars
              alVerTodo={() => setTabla("division")}
              color={COLOR_FASE[fase]}
              datos={barrasDivision}
              limite={TOPE_LISTA}
              metrica={metrica}
              onSelect={(valor) => navegar({ division: valor })}
              seleccion={filtros.division}
            />
          </section>

          <section className="dashboard-card" data-zona="tipo">
            <div className="dashboard-card-head">
              <div>
                <h2>Por tipo de venta</h2>
                <span>{ETIQUETA_FASE[fase]} · pulsa un trozo para filtrar</span>
              </div>
            </div>
            <Donut
              datos={segmentosTipoVenta}
              leyendaTotal="tipos"
              metrica={metrica}
              onSelect={(valor) => navegar({ tipo_venta: valor })}
              seleccion={filtros.tipoVenta}
            />
          </section>

          <section className="dashboard-card" data-zona="mes">
            <div className="dashboard-card-head">
              <div>
                <h2>Por mes</h2>
                <span>{ETIQUETA_FASE[fase]} · pulsa un mes para acotar</span>
              </div>
            </div>
            <RankedBars
              color={COLOR_FASE[fase]}
              datos={meses}
              metrica={metrica}
              onSelect={(valor) => valor && irAlMes(valor)}
              seleccion={desde.slice(0, 7) === hasta.slice(0, 7) ? desde.slice(0, 7) : null}
              vacio="Sin movimientos en el periodo"
            />
          </section>

          <section className="dashboard-card" data-zona="unidad">
            <div className="dashboard-card-head">
              <div>
                <h2>Cantidad por unidad</h2>
                <span>{ETIQUETA_FASE[fase]} · no sumables entre sí</span>
              </div>
            </div>
            <RankedBars
              alVerTodo={() => setTabla("unidades")}
              color={COLOR_FASE[fase]}
              datos={unidades}
              limite={5}
              metrica="lineas"
              onSelect={() => undefined}
              seleccion={null}
              vacio="Esta fase no trae cantidades"
            />
          </section>
        </div>

        {tabla === "cedis" ? (
          <Modal onClose={() => setTabla(null)} subtitulo="Las tres fases" titulo="Por CEDIS">
            <table>
              <thead>
                <tr>
                  <th>CEDIS</th>
                  {FASES.map((f) => (
                    <th className="flujo-num" key={f}>
                      {ETIQUETA_FASE[f]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from(mapaCedis.entries())
                  .sort((a, b) => valorDe(b[1][fase], metrica) - valorDe(a[1][fase], metrica))
                  .map(([clave, porFase]) => (
                    <tr className={clave === null ? "flujo-sin-asignar" : undefined} key={clave ?? "__"}>
                      <td>{clave ?? "Sin asignar"}</td>
                      {FASES.map((f) => (
                        <td className="flujo-num" key={f}>
                          {porFase[f] ? formatearMetrica(valorDe(porFase[f], metrica), metrica) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </Modal>
        ) : null}

        {tabla === "division" ? (
          <Modal onClose={() => setTabla(null)} subtitulo="Las tres fases" titulo="Por división">
            <table>
              <thead>
                <tr>
                  <th>División</th>
                  {FASES.map((f) => (
                    <th className="flujo-num" key={f}>
                      {ETIQUETA_FASE[f]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from(mapaDivision.entries())
                  .sort((a, b) => valorDe(b[1][fase], metrica) - valorDe(a[1][fase], metrica))
                  .map(([clave, porFase]) => (
                    <tr className={clave === null ? "flujo-sin-asignar" : undefined} key={clave ?? "__"}>
                      <td>{clave === null ? "Sin división" : nombreDivision.get(clave) ?? clave}</td>
                      {FASES.map((f) => (
                        <td className="flujo-num" key={f}>
                          {porFase[f] ? formatearMetrica(valorDe(porFase[f], metrica), metrica) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </Modal>
        ) : null}

        {tabla === "unidades" ? (
          <Modal
            onClose={() => setTabla(null)}
            subtitulo="No se pueden sumar entre sí"
            titulo="Cantidad por unidad"
          >
            <table>
              <thead>
                <tr>
                  <th>Fase</th>
                  <th>Unidad</th>
                  <th className="flujo-num">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {cantidad_por_unidad.map((fila) => (
                  <tr key={`${fila.fase}-${fila.unidad}`}>
                    <td>{ETIQUETA_FASE[fila.fase] ?? fila.fase}</td>
                    <td>{fila.unidad}</td>
                    <td className="flujo-num">{numero.format(Math.round(fila.cantidad_total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Modal>
        ) : null}

        {tabla === "catalogo" ? (
          <Modal
            onClose={() => setTabla(null)}
            subtitulo={`${numero.format(cedis.length)} combinaciones`}
            titulo="Catálogo de CEDIS"
          >
            <table>
              <thead>
                <tr>
                  <th>CEDIS</th>
                  <th>Sector</th>
                  <th>Almacén</th>
                  <th>Oficina</th>
                  <th>Tipo de venta</th>
                </tr>
              </thead>
              <tbody>
                {cedis.map((row: CedisRow, index) => (
                  <tr key={`${row.cedis}-${index}`}>
                    <td>{row.cedis}</td>
                    <td>{row.sector || "—"}</td>
                    <td>{row.almacen || "—"}</td>
                    <td>{row.oficina || "—"}</td>
                    <td>{row.tipo_venta || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Modal>
        ) : null}
      </div>
    </div>
  );
}
