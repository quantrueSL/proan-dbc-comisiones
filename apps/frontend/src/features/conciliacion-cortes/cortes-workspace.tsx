"use client";

// Conciliación por cortes (pestaña de pruebas, convive con la de Conciliación).
// Fase 3: solo lectura. Cabecera con filtros y totales, lista del mes (una
// celda por pago, un solo estado) y, al elegir un pago, su panel.

import { useMemo, useState } from "react";
import type { ComisionesCatalog, CortesEstado, CortesFila, CortesMesResponse, DivisionRow } from "@/types/comisiones";
import { CortesPanel } from "./cortes-panel";
import {
  ETIQUETA_ESTADO,
  ETIQUETA_TOTAL,
  etiquetaMes,
  fechaCorta,
  filaTodoCuadra,
  filtrarFilas,
  huecosDelMes,
  nombreComisionista,
  pesos,
  posicionarPagos,
  rangoCorto,
  semanasDelMes,
  textoDiferencia,
  totalesCortes
} from "./cortes-logica";

type Props = {
  initialCatalog: ComisionesCatalog;
  initialError: string | null;
  initialResponse: CortesMesResponse | null;
  mesInicial: string;
  meses: string[];
};

type Seleccion = { filaId: string; pagoId: string };

const ORDEN_ESTADOS: CortesEstado[] = ["cons", "ok", "sug", "sin", "sinv"];

function etiquetaDivision(fila: DivisionRow): { codigo: string; nombre: string } {
  const codigo = String(fila.business_area_code ?? "");
  const nombre = fila.business_area_name;
  return { codigo, nombre: nombre === null || nombre === undefined ? codigo : String(nombre) };
}

export function CortesWorkspace({ initialCatalog, initialError, initialResponse, mesInicial, meses }: Props) {
  const [mes, setMes] = useState(mesInicial);
  const [respuesta, setRespuesta] = useState(initialResponse);
  const [error, setError] = useState(initialError);
  const [cargando, setCargando] = useState(false);
  const [division, setDivision] = useState("");
  const [comisionistaId, setComisionistaId] = useState("");
  // Por defecto se ven todas las filas: quien concilia decide si oculta las que ya cuadran.
  const [soloAccion, setSoloAccion] = useState(false);
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);

  async function cargarMes(nuevo: string) {
    setMes(nuevo);
    setCargando(true);
    setError(null);
    setSeleccion(null);
    try {
      const res = await fetch("/api/comisionesbi/cortes/mes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mes: nuevo })
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

  const filas = respuesta?.filas ?? [];
  const desde = respuesta?.desde ?? `${mes}-01`;
  const hasta = respuesta?.hasta ?? `${mes}-28`;
  const semanas = useMemo(() => semanasDelMes(mes), [mes]);

  const visibles = useMemo(
    () => filtrarFilas(filas, { division, comisionistaId, soloAccion }, seleccion?.filaId),
    [filas, division, comisionistaId, soloAccion, seleccion]
  );
  const ocultas = useMemo(
    () => filtrarFilas(filas, { division, comisionistaId, soloAccion: false }).length - visibles.length,
    [filas, division, comisionistaId, visibles]
  );
  const totales = useMemo(
    () => totalesCortes(filtrarFilas(filas, { division, comisionistaId, soloAccion: false }), desde, hasta),
    [filas, division, comisionistaId, desde, hasta]
  );

  const opcionesComisionista = useMemo(() => {
    const vistos = new Map<string, string>();
    for (const f of filas) {
      if (division && f.division_code !== division) continue;
      if (!vistos.has(f.comisionista_id)) vistos.set(f.comisionista_id, nombreComisionista(f));
    }
    return Array.from(vistos.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [filas, division]);

  const hayPagosSinVentana = visibles.some((f) => f.pagos.some((p) => p.estado === "sinv"));
  const columnas = semanas.length + (hayPagosSinVentana ? 1 : 0);
  const plantilla = { gridTemplateColumns: `minmax(120px, 170px) repeat(${columnas}, minmax(76px, 1fr))` };

  const filaSeleccionada = seleccion ? filas.find((f) => f.fila_id === seleccion.filaId) ?? null : null;

  function elegir(fila: CortesFila, pagoId: string) {
    setSeleccion({ filaId: fila.fila_id, pagoId });
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
        <div className="cortes-filtros">
          <label>
            Mes
            <select disabled={cargando} onChange={(e) => void cargarMes(e.target.value)} value={mes}>
              {meses.map((m) => (
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
          <label className="cortes-check">
            <input checked={soloAccion} onChange={(e) => setSoloAccion(e.target.checked)} type="checkbox" />
            Solo lo que requiere acción
          </label>
        </div>

        <dl className="cortes-totales">
          {ORDEN_ESTADOS.map((estado) => {
            const t = totales.porEstado[estado];
            return (
              <div key={estado}>
                <dt>
                  <i className={`cortes-punto is-${estado}`} />
                  {ETIQUETA_TOTAL[estado]}
                </dt>
                <dd>{t.n}</dd>
                <small>{estado === "sinv" ? `${pesos(t.pagado)} pagado` : `${pesos(t.calculado)} calculado`}</small>
                {estado === "sug" || estado === "sin" ? <small title="Suma de las diferencias en valor absoluto">Dif. {pesos(t.difAbs)}</small> : null}
              </div>
            );
          })}
          <div>
            <dt>
              <i className="cortes-punto is-hueco" />
              Cobros sin pago
            </dt>
            <dd>{totales.sinPago.n}</dd>
            <small>{pesos(totales.sinPago.comision)} de comisión</small>
          </div>
        </dl>
      </section>

      <div className={`cortes-cuerpo${filaSeleccionada ? " con-panel" : ""}`}>
        <section aria-busy={cargando} aria-label="Pagos del mes" className="hydro-table-card cortes-lista">
          <div className="cortes-lista-tit">
            <h2>Pagos de {etiquetaMes(mes)}</h2>
            <span>
              {visibles.length} comisionista(s) · clic en una celda para ver el pago
              {cargando ? " · cargando…" : ""}
            </span>
          </div>

          {visibles.length ? (
            <div className="cortes-matriz-scroll">
              <div className="cortes-matriz">
                <div className="cortes-fila cortes-fila-cab" style={plantilla}>
                  <span />
                  {semanas.map((s) => (
                    <span key={s.ini}>{rangoCorto(s.ini, s.fin)}</span>
                  ))}
                  {hayPagosSinVentana ? <span>Sin ventana</span> : null}
                </div>
                {visibles.map((fila) => {
                  const posicionados = posicionarPagos(fila.pagos, semanas);
                  const sinVentana = fila.pagos.filter((p) => p.estado === "sinv");
                  const hueco = huecosDelMes(fila, desde, hasta);
                  return (
                    <div className="cortes-fila" key={fila.fila_id} style={plantilla}>
                      <div className="cortes-quien">
                        <b title={nombreComisionista(fila)}>{nombreComisionista(fila)}</b>
                        <span>
                          {fila.sociedad} · {fila.division_code ?? "Sin división"}
                          {filaTodoCuadra(fila) ? " · todo cuadra" : ""}
                        </span>
                        {hueco.n ? <em>Cobros sin pago: {pesos(hueco.comision)}</em> : null}
                      </div>
                      {posicionados.map(({ pago, colIni, colFin }) => {
                        const seleccionada = seleccion?.pagoId === pago.pago_id && seleccion.filaId === fila.fila_id;
                        return (
                          <button
                            aria-label={`${nombreComisionista(fila)}, pago ${rangoCorto(pago.ini!, pago.fin!)}, ${ETIQUETA_ESTADO[pago.estado]}`}
                            aria-pressed={seleccionada}
                            className={`cortes-celda is-${pago.estado}${seleccionada ? " es-seleccion" : ""}`}
                            key={pago.pago_id}
                            onClick={() => elegir(fila, pago.pago_id)}
                            style={{ gridColumn: `${colIni + 2} / ${colFin + 3}` }}
                            title={`${rangoCorto(pago.ini!, pago.fin!)} · pagado ${pesos(pago.pagado)}`}
                            type="button"
                          >
                            <span className="cortes-celda-estado">
                              <i className={`cortes-punto is-${pago.estado}`} />
                              {ETIQUETA_ESTADO[pago.estado]}
                            </span>
                            <span className="cortes-celda-valor">{textoDiferencia(pago.diferencia)}</span>
                          </button>
                        );
                      })}
                      {hayPagosSinVentana
                        ? sinVentana.map((pago) => {
                            const seleccionada = seleccion?.pagoId === pago.pago_id && seleccion.filaId === fila.fila_id;
                            return (
                              <button
                                aria-pressed={seleccionada}
                                className={`cortes-celda is-sinv${seleccionada ? " es-seleccion" : ""}`}
                                key={pago.pago_id}
                                onClick={() => elegir(fila, pago.pago_id)}
                                style={{ gridColumn: `${semanas.length + 2} / ${semanas.length + 3}` }}
                                type="button"
                              >
                                <span className="cortes-celda-estado">
                                  <i className="cortes-punto is-sinv" />
                                  {ETIQUETA_ESTADO.sinv}
                                </span>
                                <span className="cortes-celda-valor">{pesos(pago.pagado)}</span>
                              </button>
                            );
                          })
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="hydro-muted cortes-vacio">
              {filas.length ? "Ninguna fila coincide con los filtros." : "Sin pagos en este mes."}
            </p>
          )}

          {ocultas > 0 ? (
            <p className="cortes-ocultas">
              {ocultas} comisionista(s) ocultos porque todo cuadra o ya está consolidado.{" "}
              <button onClick={() => setSoloAccion(false)} type="button">
                Mostrar todos
              </button>
            </p>
          ) : null}

          <div className="cortes-leyenda">
            {ORDEN_ESTADOS.map((e) => (
              <span key={e}>
                <i className={`cortes-punto is-${e}`} />
                {ETIQUETA_ESTADO[e]}
              </span>
            ))}
          </div>
        </section>

        {filaSeleccionada && seleccion ? (
          <CortesPanel
            filaResumen={filaSeleccionada}
            mes={mes}
            onCerrar={() => setSeleccion(null)}
            pagoId={seleccion.pagoId}
          />
        ) : null}
      </div>
    </div>
  );
}
