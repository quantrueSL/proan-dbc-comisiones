"use client";

// Conciliación por cortes (pestaña de pruebas, convive con la de Conciliación).
// Cabecera con filtros y totales; tabla con un total por comisionista que se abre
// por división (una celda por pago, un solo estado); y, al elegir un pago, su
// panel a la derecha, fijo mientras se recorre la lista.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { ComisionesCatalog, CortesEstado, CortesFila, CortesMesResponse, CortesPago, DivisionRow } from "@/types/comisiones";
import { CortesPanel } from "./cortes-panel";
import {
  ETIQUETA_ESTADO,
  ETIQUETA_TOTAL,
  agruparPorComisionista,
  colaDePagos,
  esPendiente,
  etiquetaMes,
  fechaCorta,
  filaTodoCuadra,
  filtrarFilas,
  desplazarVista,
  etiquetaVista,
  finDeVista,
  hayDrift,
  huecosDelMes,
  mesDeVista,
  pesos,
  posicionarPagos,
  rangoCorto,
  resumenLote,
  semanasDeVista,
  semanasDelMes,
  siguientePendiente,
  textoDiferencia,
  totalesCortes,
  totalesPorColumna,
  vistaDeMes,
  vistaParaPago,
  type RefPago,
  type VistaSemanas
} from "./cortes-logica";

type Props = {
  /** Hoy (fecha de México): las flechas no pasan de la semana en curso. */
  hoy: string;
  initialCatalog: ComisionesCatalog;
  initialError: string | null;
  initialResponse: CortesMesResponse | null;
  mesInicial: string;
  meses: string[];
  /** Solo el rol con permiso mueve cortes y aplica sugerencias; el resto ve. */
  puedeEditar: boolean;
};

type Seleccion = { filaId: string; pagoId: string };

const ESTADOS_ARRIBA: CortesEstado[] = ["cons", "ok", "sug", "sin"];

function etiquetaDivision(fila: DivisionRow): { codigo: string; nombre: string } {
  const codigo = String(fila.business_area_code ?? "");
  const nombre = fila.business_area_name;
  return { codigo, nombre: nombre === null || nombre === undefined ? codigo : String(nombre) };
}

function conFilaNueva(respuesta: CortesMesResponse, nueva: CortesFila): CortesMesResponse {
  const { desde, hasta } = respuesta;
  // Una edición devuelve la fila completa del rango cargado; la lista solo enseña los pagos que tocan el mes.
  const pagos = nueva.pagos.filter((p) => p.estado === "sinv" || (p.ini !== null && p.fin !== null && p.ini <= hasta && p.fin >= desde));
  return { ...respuesta, filas: respuesta.filas.map((f) => (f.fila_id === nueva.fila_id ? { ...nueva, pagos } : f)) };
}

export function CortesWorkspace({ hoy, initialCatalog, initialError, initialResponse, mesInicial, meses, puedeEditar }: Props) {
  // Las semanas que se ven. El selector de mes las coloca y las flechas las desplazan de una en una.
  const [vista, setVista] = useState<VistaSemanas>(() => vistaDeMes(mesInicial));
  const mes = mesDeVista(vista);
  const [respuesta, setRespuesta] = useState(initialResponse);
  const [error, setError] = useState(initialError);
  const [cargando, setCargando] = useState(false);
  const [division, setDivision] = useState("");
  const [comisionistaId, setComisionistaId] = useState("");
  // Por defecto se ven todas las filas: quien concilia decide si oculta las que ya cuadran.
  const [soloAccion, setSoloAccion] = useState(false);
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  // Después de aplicar una sugerencia: quedarse en el pago (con un aviso) o saltar solo al siguiente pendiente.
  const [saltarSolo, setSaltarSolo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // "Consolidar lo que cuadra": primero se pide confirmar; luego se manda al servidor, que arma el plan.
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  const [procesandoLote, setProcesandoLote] = useState(false);
  const [avisoLote, setAvisoLote] = useState<string | null>(null);
  // Sube al recargar el mes después de un lote: el panel abierto vuelve a pedir su fila.
  const [refrescos, setRefrescos] = useState(0);

  const cuerpoDe = (v: VistaSemanas) => ({ desde: v.ini, hasta: finDeVista(v) });

  // `conservar`: al ir a un pago que está en otras semanas, ese pago queda elegido.
  async function cargarVista(nueva: VistaSemanas, conservar: Seleccion | null = null) {
    setVista(nueva);
    setCargando(true);
    setError(null);
    setSeleccion(conservar);
    setAviso(null);
    try {
      const res = await fetch("/api/comisionesbi/cortes/mes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpoDe(nueva))
      });
      const payload = (await res.json().catch(() => null)) as (CortesMesResponse & { detail?: string }) | null;
      if (!res.ok || !payload) throw new Error(payload?.detail || "No se pudo cargar la conciliación.");
      setRespuesta(payload);
    } catch (causa) {
      setError(causa instanceof Error ? causa.message : "No se pudo cargar la conciliación.");
    } finally {
      setCargando(false);
    }
  }

  const cargarMes = (nuevo: string) => cargarVista(vistaDeMes(nuevo));
  const primeraSemana = vistaDeMes(meses[meses.length - 1] ?? mesInicial).ini;
  const puedeIrAtras = vista.ini > primeraSemana;
  const puedeIrAdelante = desplazarVista(vista, 1).ini <= hoy;
  const mover = (semanas: number) => void cargarVista(desplazarVista(vista, semanas));

  async function consolidarLote() {
    setProcesandoLote(true);
    setConfirmandoLote(false);
    setAvisoLote(null);
    try {
      const res = await fetch("/api/comisionesbi/cortes/editar/consolidar-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cuerpoDe(vista), fila_ids: filasFiltradas.map((f) => f.fila_id) })
      });
      const payload = (await res.json().catch(() => null)) as { consolidados?: number; filas?: number; omitidas?: number; detail?: string } | null;
      if (!res.ok || !payload) throw new Error(payload?.detail || "No se pudo consolidar.");
      const lista = await fetch("/api/comisionesbi/cortes/mes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpoDe(vista))
      });
      const nueva = (await lista.json().catch(() => null)) as CortesMesResponse | null;
      if (lista.ok && nueva) setRespuesta(nueva);
      setRefrescos((n) => n + 1);
      const omitidas = payload.omitidas ? ` ${payload.omitidas} fila(s) se saltaron porque alguien más las estaba editando.` : "";
      setAvisoLote(`Se consolidaron ${payload.consolidados ?? 0} pago(s) en ${payload.filas ?? 0} fila(s).${omitidas}`);
    } catch (causa) {
      setAvisoLote(causa instanceof Error ? causa.message : "No se pudo consolidar.");
    } finally {
      setProcesandoLote(false);
    }
  }

  const filas = respuesta?.filas ?? [];
  const desde = respuesta?.desde ?? vista.ini;
  const hasta = respuesta?.hasta ?? finDeVista(vista);
  const semanas = useMemo(() => semanasDeVista(vista), [vista]);

  const nombresDivision = useMemo(() => {
    const mapa: Record<string, string> = {};
    for (const row of initialCatalog.divisiones) {
      const { codigo, nombre } = etiquetaDivision(row);
      if (codigo) mapa[codigo] = nombre;
    }
    return mapa;
  }, [initialCatalog]);
  /** "Huevo + Abarrotes" si el pago de esta fila cubre varias divisiones. */
  const nombreDeFila = (f: CortesFila): string =>
    [f.division_code, ...(f.junta_con ?? [])]
      .map((c) => (c ? nombresDivision[c] ?? c : "Sin división"))
      .join(" + ");

  const filasFiltradas = useMemo(
    () => filtrarFilas(filas, { division, comisionistaId, soloAccion: false }),
    [filas, division, comisionistaId]
  );
  const visibles = useMemo(
    () => filtrarFilas(filas, { division, comisionistaId, soloAccion }, seleccion?.filaId),
    [filas, division, comisionistaId, soloAccion, seleccion]
  );
  const ocultas = filasFiltradas.length - visibles.length;
  const totales = useMemo(() => totalesCortes(filasFiltradas, desde, hasta), [filasFiltradas, desde, hasta]);
  const grupos = useMemo(() => agruparPorComisionista(visibles), [visibles]);
  const lote = useMemo(() => resumenLote(filasFiltradas), [filasFiltradas]);

  const opcionesComisionista = useMemo(() => {
    const vistos = new Map<string, string>();
    for (const g of agruparPorComisionista(filas.filter((f) => !division || f.division_code === division || (f.junta_con ?? []).includes(division)))) {
      vistos.set(g.filas[0].comisionista_id, g.nombre);
    }
    return Array.from(vistos.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [filas, division]);

  const hayPagosSinVentana = visibles.some((f) => f.pagos.some((p) => p.estado === "sinv"));
  const columnas = semanas.length + (hayPagosSinVentana ? 1 : 0);
  const plantilla = { gridTemplateColumns: `minmax(210px, 270px) repeat(${columnas}, minmax(116px, 1fr))` };

  const filaSeleccionada = seleccion ? filas.find((f) => f.fila_id === seleccion.filaId) ?? null : null;
  const cola = useMemo(() => colaDePagos(grupos, semanas), [grupos, semanas]);

  // Ir a otro pago de la fila elegida; si está en otras semanas, la vista se desplaza hasta él y el pago queda elegido.
  function irAPago(pago: CortesPago) {
    if (!seleccion) return;
    const destino = vistaParaPago(pago, vista);
    if (destino === null) {
      elegir({ filaId: seleccion.filaId, pagoId: pago.pago_id });
      return;
    }
    const fila = filas.find((f) => f.fila_id === seleccion.filaId);
    if (fila) setAbiertos((previos) => new Set(previos).add(fila.comisionista_id));
    void cargarVista(destino, { filaId: seleccion.filaId, pagoId: pago.pago_id });
  }

  function elegir(ref: RefPago, mensaje: string | null = null) {
    setSeleccion({ filaId: ref.filaId, pagoId: ref.pagoId });
    setAviso(mensaje);
    const fila = filas.find((f) => f.fila_id === ref.filaId);
    if (fila) {
      const clave = fila.comisionista_id;
      setAbiertos((previos) => (previos.has(clave) ? previos : new Set(previos).add(clave)));
    }
  }

  // Lleva la celda elegida a la vista dentro de la tabla (que tiene su propio scroll).
  useEffect(() => {
    if (!seleccion) return;
    document.querySelector(".cortes-celda.es-seleccion")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [seleccion, abiertos]);

  function pendienteEn(lista: CortesFila[]) {
    return (ref: RefPago) => {
      const pago = lista.find((f) => f.fila_id === ref.filaId)?.pagos.find((p) => p.pago_id === ref.pagoId);
      return !!pago && esPendiente(pago);
    };
  }

  function irAlSiguientePendiente(lista: CortesFila[] = filas, mensaje: string | null = null) {
    const colaActual = lista === filas ? cola : colaDePagos(agruparPorComisionista(filtrarFilas(lista, { division, comisionistaId, soloAccion }, seleccion?.filaId)), semanas);
    const sig = siguientePendiente(colaActual, seleccion, pendienteEn(lista));
    if (sig) elegir(sig, mensaje);
    else setAviso(`${mensaje ? `${mensaje} ` : ""}No quedan pagos pendientes con estos filtros.`);
  }

  // Tecla N: salta al siguiente pago pendiente (no si se está escribiendo o eligiendo en un campo).
  useEffect(() => {
    function alTeclear(e: KeyboardEvent) {
      if ((e.key !== "n" && e.key !== "N") || e.ctrlKey || e.metaKey || e.altKey) return;
      const destino = e.target as HTMLElement | null;
      if (destino && /^(INPUT|SELECT|TEXTAREA)$/.test(destino.tagName)) return;
      irAlSiguientePendiente();
    }
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  });

  function filaActualizada(nueva: CortesFila) {
    setRespuesta((actual) => (actual ? conFilaNueva(actual, nueva) : actual));
  }

  // Una sugerencia aplicada: se avisa en el mismo pago o, si la persona lo pidió, se pasa al siguiente pendiente.
  function accionHecha(mensaje: string, nueva: CortesFila, avanzar = true) {
    if (avanzar && saltarSolo && respuesta) irAlSiguientePendiente(conFilaNueva(respuesta, nueva).filas, mensaje);
    else setAviso(mensaje);
  }

  // Con un solo comisionista a la vista ya está desplegado y no hay nada que contraer.
  const todosAbiertos = grupos.length > 0 && (grupos.length === 1 || grupos.every((g) => abiertos.has(g.clave)));
  function desplegarTodo() {
    setAbiertos((previos) => {
      const siguiente = new Set(previos);
      for (const g of grupos) {
        if (todosAbiertos) siguiente.delete(g.clave);
        else siguiente.add(g.clave);
      }
      return siguiente;
    });
  }

  function alternarGrupo(clave: string) {
    setAbiertos((previos) => {
      const siguiente = new Set(previos);
      if (!siguiente.delete(clave)) siguiente.add(clave);
      return siguiente;
    });
  }

  return (
    <div className="hydro-page cortes-pagina" data-module="conciliacion-cortes">
      {error ? <p className="hydro-error">{error}</p> : null}

      <header className="cortes-cab">
        <div className="cortes-cab-titulo">
          <p>Conciliación por cortes · pestaña de pruebas</p>
          <h1>Comisión calculada frente a comisión pagada</h1>
          <span>
            Cada celda es un pago del mes. El valor es calculado − pagado.
            {respuesta?.cobertura?.hasta ? ` Cobros disponibles hasta el ${fechaCorta(respuesta.cobertura.hasta)}.` : ""}
          </span>
        </div>
      </header>

      <section aria-label="Filtros y totales" className="cortes-barra">
        <div className="cortes-barra-izq">
          <div className="cortes-filtros">
            <label>
              Mes
              <select disabled={cargando} onChange={(e) => void cargarMes(e.target.value)} value={mes}>
                {(meses.includes(mes) ? meses : [mes, ...meses]).map((m) => (
                  <option key={m} value={m}>
                    {etiquetaMes(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              División
              <select
                onChange={(e) => {
                  setDivision(e.target.value);
                  setComisionistaId("");
                }}
                value={division}
              >
                <option value="">Todas</option>
                {initialCatalog.divisiones.map((row, i) => {
                  const { codigo, nombre } = etiquetaDivision(row);
                  return (
                    <option key={`${codigo}-${i}`} value={codigo}>
                      {nombre}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              Comisionista
              <select onChange={(e) => setComisionistaId(e.target.value)} value={comisionistaId}>
                <option value="">Todos</option>
                {opcionesComisionista.map(([id, nombre]) => (
                  <option key={id} value={id}>
                    {nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="cortes-selectores">
            <label className="cortes-check">
              <input checked={soloAccion} onChange={(e) => setSoloAccion(e.target.checked)} type="checkbox" />
              Solo lo que requiere acción
            </label>
            <button
              className="cortes-boton"
              disabled={!puedeEditar || lote.pagos === 0 || procesandoLote || cargando}
              onClick={() => setConfirmandoLote(true)}
              title={puedeEditar ? "Consolida de izquierda a derecha, hasta el primer pago que no cuadra de cada fila" : "Solo lectura: tu rol no puede consolidar"}
              type="button"
            >
              Consolidar lo que cuadra ({lote.pagos})
            </button>
          </div>
          {confirmandoLote ? (
            <div className="cortes-confirmar" role="alertdialog">
              <p>
                Se consolidarán {lote.pagos} pago(s) de {lote.filas} fila(s), de izquierda a derecha, hasta el primero que no cuadra de cada una. Sus
                cortes quedarán congelados.
              </p>
              <div className="cortes-acciones">
                <button className="cortes-boton is-primario" onClick={() => void consolidarLote()} type="button">
                  Consolidar
                </button>
                <button className="cortes-boton" onClick={() => setConfirmandoLote(false)} type="button">
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          {procesandoLote ? <p className="cortes-nota">Consolidando…</p> : null}
          {avisoLote ? (
            <p className="cortes-flash" role="status">
              {avisoLote}
            </p>
          ) : null}
        </div>

        <dl className="cortes-kpis">
          {ESTADOS_ARRIBA.map((estado) => {
            const t = totales.porEstado[estado];
            return (
              <div className={`cortes-kpi is-${estado}`} key={estado}>
                <dt>{ETIQUETA_TOTAL[estado]}</dt>
                <dd>{t.n}</dd>
                <small>{pesos(t.calculado)} calculado</small>
                {estado === "sug" || estado === "sin" ? <small title="Suma de las diferencias en valor absoluto">Dif. {pesos(t.difAbs)}</small> : null}
              </div>
            );
          })}
          <div className="cortes-kpi is-sinv">
            <dt>{ETIQUETA_TOTAL.sinv}</dt>
            <dd>{totales.porEstado.sinv.n}</dd>
            <small>{pesos(totales.porEstado.sinv.pagado)} pagado</small>
          </div>
          <div className="cortes-kpi is-hueco es-ancho">
            <dt>Comisión calculada sin pago</dt>
            <dd>{totales.sinPago.n}</dd>
            <small>{pesos(totales.sinPago.comision)} de comisión</small>
            {totales.cierre.n ? (
              <small title="Lo cobrado el último día del mes no entra en el pago de su semana y aún no está asignado a otro pago">
                Cierre de mes: {pesos(totales.cierre.comision)}
              </small>
            ) : null}
          </div>
        </dl>
      </section>

      <div className={`cortes-cuerpo${filaSeleccionada ? " con-panel" : ""}`}>
        <section aria-busy={cargando} aria-label="Pagos del mes" className="hydro-table-card cortes-lista">
          <div className="cortes-lista-tit">
            <button
              aria-label="Una semana atrás"
              className="cortes-boton cortes-semana-flecha"
              disabled={cargando || !puedeIrAtras}
              onClick={() => mover(-1)}
              type="button"
            >
              ◀ Semana anterior
            </button>
            <div className="cortes-lista-centro">
              <h2>Pagos de {etiquetaVista(vista)} por comisionista</h2>
              <span>
                {grupos.length} comisionista(s) · el total muestra pagado y calculado; ábrelo para ver cada división con su diferencia
                {cargando ? " · cargando…" : ""}
              </span>
              <button className="cortes-ir" disabled={grupos.length < 2} onClick={desplegarTodo} type="button">
                {todosAbiertos ? "Contraer todo" : "Desplegar todo"}
              </button>
            </div>
            <button
              aria-label="Una semana adelante"
              className="cortes-boton cortes-semana-flecha"
              disabled={cargando || !puedeIrAdelante}
              onClick={() => mover(1)}
              type="button"
            >
              Semana siguiente ▶
            </button>
          </div>

          {grupos.length ? (
            <div className="cortes-matriz-scroll">
              <div className="cortes-matriz">
                <div className="cortes-fila cortes-fila-cab" style={plantilla}>
                  <span className="cortes-cab-quien">Comisionista / división</span>
                  {semanas.map((s) => (
                    <span key={s.ini}>{rangoCorto(s.ini, s.fin)}</span>
                  ))}
                  {hayPagosSinVentana ? <span>Sin ventana</span> : null}
                </div>

                {grupos.map((grupo) => {
                  // Con un solo comisionista a la vista no hay nada que ahorrar: se enseñan sus divisiones.
                  const abierto = abiertos.has(grupo.clave) || grupos.length === 1;
                  const porRevisar = grupo.filas.reduce((n, f) => n + f.pagos.filter((p) => p.estado !== "ok" && p.estado !== "cons").length, 0);
                  const totalesCol = totalesPorColumna(grupo.filas, semanas);
                  const contiene = seleccion ? grupo.filas.some((f) => f.fila_id === seleccion.filaId) : false;
                  const nDivisiones = grupo.filas.length;
                  return (
                    <Fragment key={grupo.clave}>
                      <div className={`cortes-fila cortes-fila-total${contiene ? " con-seleccion" : ""}`} style={plantilla}>
                        <div className="cortes-quien">
                          <button aria-expanded={abierto} onClick={() => alternarGrupo(grupo.clave)} type="button">
                            <span aria-hidden="true" className={`cortes-flecha${abierto ? " es-abierta" : ""}`}>
                              ▶
                            </span>
                            <b title={grupo.nombre}>{grupo.nombre}</b>
                          </button>
                          <span>
                            {nDivisiones} {nDivisiones === 1 ? "división" : "divisiones"} · {porRevisar ? `${porRevisar} pago(s) por revisar` : "todo cuadra"}
                          </span>
                        </div>
                        {totalesCol.slice(0, columnas).map((c, i) =>
                          c.n ? (
                            <div className="cortes-total-col" key={i}>
                              <span>
                                <em>Pag.</em> {pesos(c.pagado)}
                              </span>
                              {i < semanas.length ? (
                                <span>
                                  <em>Calc.</em> {pesos(c.calculado)}
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <div className="cortes-total-col is-vacio" key={i}>
                              —
                            </div>
                          )
                        )}
                      </div>

                      {abierto
                        ? grupo.filas.map((fila) => {
                            const posicionados = posicionarPagos(fila.pagos, semanas);
                            const sinVentana = fila.pagos.filter((p) => p.estado === "sinv");
                            const hueco = huecosDelMes(fila, desde, hasta);
                            const cubiertas = new Set<number>();
                            posicionados.forEach(({ colIni, colFin }) => {
                              for (let c = colIni; c <= colFin; c++) cubiertas.add(c);
                            });
                            const esFilaElegida = seleccion?.filaId === fila.fila_id;
                            return (
                              <div className={`cortes-fila cortes-fila-division${esFilaElegida ? " con-seleccion" : ""}`} key={fila.fila_id} style={plantilla}>
                                <div className="cortes-quien">
                                  <b>{nombreDeFila(fila)}</b>
                                  <span>
                                    {fila.sociedad}
                                    {fila.junta_con?.length ? " · se paga junto" : ""}
                                    {filaTodoCuadra(fila) ? " · todo cuadra" : ""}
                                  </span>
                                  {hueco.n ? <em>Comisión calculada sin pago: {pesos(hueco.comision)}</em> : null}
                                  {fila.huerfanos?.length ? <em>⚠ {fila.huerfanos.length} guardado(s) de un documento que ya no está</em> : null}
                                </div>
                                {posicionados.map(({ pago, colIni, colFin }) => {
                                  const elegida = seleccion?.pagoId === pago.pago_id && esFilaElegida;
                                  return (
                                    <button
                                      aria-label={`${grupo.nombre}, ${nombreDeFila(fila)}, pago ${rangoCorto(pago.ini!, pago.fin!)}, ${ETIQUETA_ESTADO[pago.estado]}`}
                                      aria-pressed={elegida}
                                      className={`cortes-celda is-${pago.estado}${elegida ? " es-seleccion" : ""}`}
                                      key={pago.pago_id}
                                      onClick={() => elegir({ filaId: fila.fila_id, pagoId: pago.pago_id })}
                                      style={{ gridColumn: `${colIni + 2} / ${colFin + 3}` }}
                                      title={`${rangoCorto(pago.ini!, pago.fin!)} · pagado ${pesos(pago.pagado)}`}
                                      type="button"
                                    >
                                      <span className="cortes-celda-estado">
                                        <i className={`cortes-punto is-${pago.estado}`} />
                                        {ETIQUETA_ESTADO[pago.estado]}
                                        {hayDrift(pago) ? (
                                          <span className="cortes-celda-cambio" title="Los datos cambiaron desde que se consolidó">
                                            ⚠ Cambió
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="cortes-celda-fila">
                                        <em>Pag.</em> {pesos(pago.pagado)}
                                      </span>
                                      <span className="cortes-celda-fila">
                                        <em>Calc.</em> {pago.calculado === null ? "—" : pesos(pago.calculado)}
                                      </span>
                                      <span className="cortes-celda-fila is-dif">
                                        <em>Dif.</em> <b>{textoDiferencia(pago.diferencia)}</b>
                                      </span>
                                    </button>
                                  );
                                })}
                                {semanas.map((_, c) =>
                                  cubiertas.has(c) ? null : (
                                    <div className="cortes-celda-vacia" key={`v${c}`} style={{ gridColumn: c + 2 }}>
                                      —
                                    </div>
                                  )
                                )}
                                {hayPagosSinVentana
                                  ? sinVentana.map((pago) => {
                                      const elegida = seleccion?.pagoId === pago.pago_id && esFilaElegida;
                                      return (
                                        <button
                                          aria-pressed={elegida}
                                          className={`cortes-celda is-sinv${elegida ? " es-seleccion" : ""}`}
                                          key={pago.pago_id}
                                          onClick={() => elegir({ filaId: fila.fila_id, pagoId: pago.pago_id })}
                                          style={{ gridColumn: `${semanas.length + 2} / ${semanas.length + 3}` }}
                                          type="button"
                                        >
                                          <span className="cortes-celda-estado">
                                            <i className="cortes-punto is-sinv" />
                                            {ETIQUETA_ESTADO.sinv}
                                          </span>
                                          <span className="cortes-celda-fila">
                                            <em>Pag.</em> {pesos(pago.pagado)}
                                          </span>
                                        </button>
                                      );
                                    })
                                  : null}
                              </div>
                            );
                          })
                        : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="hydro-muted cortes-vacio">
              {filas.length ? "Ninguna fila coincide con los filtros." : "Sin pagos en este mes."}
            </p>
          )}

          <div className="cortes-pie-lista">
            <div className="cortes-leyenda">
              {(["ok", "sug", "sin", "sinv", "cons"] as CortesEstado[]).map((e) => (
                <span key={e}>
                  <i className={`cortes-punto is-${e}`} />
                  {ETIQUETA_ESTADO[e]}
                </span>
              ))}
            </div>
            {ocultas > 0 ? (
              <p className="cortes-ocultas">
                {ocultas} fila(s) ocultas porque todo cuadra o ya está consolidado.{" "}
                <button onClick={() => setSoloAccion(false)} type="button">
                  Mostrar todas
                </button>
              </p>
            ) : null}
          </div>
        </section>

        {filaSeleccionada && seleccion ? (
          <CortesPanel
            aviso={aviso}
            key={refrescos}
            etiquetaDivision={nombreDeFila(filaSeleccionada)}
            filaResumen={filaSeleccionada}
            mes={mes}
            nombresDivision={nombresDivision}
            onAccionHecha={accionHecha}
            onCerrar={() => {
              setSeleccion(null);
              setAviso(null);
            }}
            onElegirPago={irAPago}
            onFilaActualizada={filaActualizada}
            onSaltarSoloChange={setSaltarSolo}
            onSiguientePendiente={() => irAlSiguientePendiente()}
            pagoId={seleccion.pagoId}
            puedeEditar={puedeEditar}
            saltarSolo={saltarSolo}
          />
        ) : null}
      </div>
    </div>
  );
}
