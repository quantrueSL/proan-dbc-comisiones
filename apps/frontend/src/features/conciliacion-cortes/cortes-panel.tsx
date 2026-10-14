"use client";

// Panel de un pago: línea de tiempo con los cortes, sugerencia o advertencia y,
// aparte, el detalle por producto de su ventana. Quien tiene permiso puede mover
// un corte con las flechas (los clics seguidos se juntan en un solo guardado),
// aplicar o descartar la sugerencia y devolver el pago a la ventana del texto.
// Consolidar llega en la siguiente fase.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CortesAccion,
  CortesDetalleResponse,
  CortesEvento,
  CortesFila,
  CortesFilaResponse,
  CortesHistorialResponse,
  CortesPago
} from "@/types/comisiones";
import {
  ETIQUETA_ESTADO,
  cortesMovidos,
  describirMovimiento,
  diasQueCambian,
  elementosDeLinea,
  fechaConDia,
  fechaCorta,
  limitesDeCorte,
  moverCorteLocal,
  nombreComisionista,
  pagosEnVista,
  pesos,
  rangoCorto,
  sumarDias,
  textoDiferencia
} from "./cortes-logica";

type Props = {
  mes: string;
  filaResumen: CortesFila;
  pagoId: string;
  puedeEditar: boolean;
  onCerrar: () => void;
  /** La fila ya guardada: la lista del mes se actualiza con ella. */
  onFilaActualizada: (fila: CortesFila) => void;
};

const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const PAUSA_PARA_GUARDAR_MS = 700;

async function pedir<T>(ruta: string, cuerpo: unknown): Promise<T> {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo)
  });
  const payload = (await res.json().catch(() => null)) as (T & { detail?: string }) | null;
  if (!res.ok || !payload) throw new Error(payload?.detail || "No se pudo cargar el pago.");
  return payload;
}

function Pastilla({ estado }: { estado: CortesPago["estado"] }) {
  return <span className={`cortes-pastilla is-${estado}`}>{ETIQUETA_ESTADO[estado]}</span>;
}

function Cifras({ pago }: { pago: CortesPago }) {
  const dif = pago.diferencia;
  const cuadra = dif !== null && Math.abs(dif) <= 1;
  return (
    <dl className="cortes-cifras">
      <div>
        <dt>Pagado</dt>
        <dd>{pesos(pago.pagado)}</dd>
      </div>
      <div>
        <dt>Calculado</dt>
        <dd>{pago.calculado === null ? "—" : pesos(pago.calculado)}</dd>
      </div>
      <div>
        <dt>Diferencia</dt>
        <dd className={dif === null ? "" : cuadra ? "is-cuadra" : "is-dif"}>{textoDiferencia(dif)}</dd>
      </div>
    </dl>
  );
}

const formatoMomento = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Mexico_City"
});

function describirEvento(e: CortesEvento): string {
  const fecha = e.detalle?.fecha ? fechaConDia(e.detalle.fecha) : "";
  switch (e.tipo) {
    case "mover_corte":
      return `movió un corte al ${fecha}`;
    case "mover_borde":
      return `movió el ${e.detalle?.borde === "ini" ? "inicio" : "fin"} de un pago al ${fecha}`;
    case "aplicar_sugerencia":
      return "aplicó la sugerencia";
    case "descartar_sugerencia":
      return "descartó la sugerencia";
    case "recuperar_sugerencia":
      return "recuperó la sugerencia";
    case "restablecer_pago":
      return "devolvió un pago a la ventana del texto";
    default:
      return e.tipo;
  }
}

export function CortesPanel({ mes, filaResumen, pagoId, puedeEditar, onCerrar, onFilaActualizada }: Props) {
  const [tab, setTab] = useState<"cortes" | "detalle">("cortes");
  const [contexto, setContexto] = useState(1);
  const [datos, setDatos] = useState<CortesFilaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<CortesDetalleResponse | null>(null);
  const [detalleError, setDetalleError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<{ izqId: string; fecha: string } | null>(null);
  const [historial, setHistorial] = useState<CortesEvento[] | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ultimaFecha = useRef<{ izqId: string; fecha: string } | null>(null);

  const cargarFila = useCallback(async () => {
    const r = await pedir<CortesFilaResponse>("/api/comisionesbi/cortes/fila", {
      mes,
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code
    });
    setDatos(r);
    return r;
  }, [mes, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  // Cambió el pago: se vuelve a la pestaña de cortes y se vuelve a pedir la fila.
  useEffect(() => {
    let vigente = true;
    setTab("cortes");
    setDatos(null);
    setDetalle(null);
    setError(null);
    setDetalleError(null);
    setAviso(null);
    setPendiente(null);
    setHistorial(null);
    cargarFila().catch((e) => vigente && setError(e instanceof Error ? e.message : "No se pudo cargar el pago."));
    return () => {
      vigente = false;
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, [cargarFila, filaResumen.fila_id, pagoId]);

  const filaBase = datos?.fila ?? null;
  const dias = useMemo(() => new Map(datos?.dias ?? []), [datos]);
  // Mientras hay un corte sin guardar se dibuja con la vista previa local.
  const fila = useMemo(
    () => (filaBase && pendiente ? moverCorteLocal(filaBase, dias, pendiente.izqId, pendiente.fecha) : filaBase),
    [filaBase, dias, pendiente]
  );
  const pago = (fila ?? filaResumen).pagos.find((p) => p.pago_id === pagoId) ?? null;

  // El detalle por producto se pide solo al abrir su pestaña (y otra vez si la ventana cambió).
  const ventanaKey = pago?.ini && pago.fin ? `${pago.ini}|${pago.fin}` : null;
  useEffect(() => {
    setDetalle(null);
    setDetalleError(null);
  }, [ventanaKey]);
  useEffect(() => {
    if (tab !== "detalle" || !ventanaKey || detalle || pendiente) return;
    const [ini, fin] = ventanaKey.split("|");
    let vigente = true;
    pedir<CortesDetalleResponse>("/api/comisionesbi/cortes/detalle", {
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code,
      ini,
      fin
    })
      .then((r) => vigente && setDetalle(r))
      .catch((e) => vigente && setDetalleError(e instanceof Error ? e.message : "No se pudo cargar el detalle."));
    return () => {
      vigente = false;
    };
  }, [tab, ventanaKey, detalle, pendiente, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  async function editar(accion: CortesAccion, extra: Record<string, unknown>): Promise<boolean> {
    if (!filaBase) return false;
    setGuardando(true);
    setAviso(null);
    try {
      const res = await fetch(`/api/comisionesbi/cortes/editar/${accion}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mes,
          sociedad: filaResumen.sociedad,
          comisionista_id: filaResumen.comisionista_id,
          division_code: filaResumen.division_code,
          version: filaBase.version,
          ...extra
        })
      });
      const payload = (await res.json().catch(() => null)) as (CortesFilaResponse & { detail?: string; codigo?: string }) | null;
      if (res.ok && payload?.fila) {
        setDatos(payload);
        setHistorial(null);
        onFilaActualizada(payload.fila);
        return true;
      }
      if (res.status === 409 && payload?.codigo === "conflicto_version") {
        setAviso("Otra persona cambió esta fila mientras la editabas. Se cargó lo último.");
        const nueva = await cargarFila().catch(() => null);
        if (nueva?.fila) onFilaActualizada(nueva.fila);
      } else {
        setAviso(payload?.detail || "No se pudo guardar el cambio.");
      }
      return false;
    } catch {
      setAviso("No se pudo guardar el cambio. Vuelve a intentarlo en unos instantes.");
      return false;
    } finally {
      setPendiente(null);
      ultimaFecha.current = null;
      setGuardando(false);
    }
  }

  // Un clic mueve el corte un día en la vista previa; cuando pasan 700 ms sin otro clic, se guarda UNA vez.
  function moverCorte(izqId: string, delta: number) {
    if (!filaBase || guardando) return;
    const actual = ultimaFecha.current?.izqId === izqId ? ultimaFecha.current.fecha : filaBase.cortes.find((c) => c.izq === izqId)?.fecha;
    const limites = limitesDeCorte(filaBase, izqId);
    if (!actual || !limites) return;
    const nueva = sumarDias(actual, delta);
    if (nueva < limites.min || nueva > limites.max) return;
    ultimaFecha.current = { izqId, fecha: nueva };
    setPendiente({ izqId, fecha: nueva });
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      const ultima = ultimaFecha.current;
      const guardada = filaBase.cortes.find((c) => c.izq === izqId)?.fecha;
      if (!ultima || ultima.fecha === guardada) {
        ultimaFecha.current = null;
        setPendiente(null);
        return;
      }
      void editar("mover", { izq_pago_id: ultima.izqId, fecha: ultima.fecha });
    }, PAUSA_PARA_GUARDAR_MS);
  }

  async function abrirHistorial(abierto: boolean) {
    if (!abierto || historial) return;
    try {
      const r = await pedir<CortesHistorialResponse>("/api/comisionesbi/cortes/editar/historial", {
        sociedad: filaResumen.sociedad,
        comisionista_id: filaResumen.comisionista_id,
        division_code: filaResumen.division_code,
        limite: 20
      });
      setHistorial(r.eventos);
    } catch {
      setHistorial([]);
    }
  }

  if (!pago) return null;
  const sinVentana = pago.ini === null || pago.fin === null;
  const sugerencia = pago.estado === "sug" && !pendiente ? pago.sugerencia : null;
  const marcados = diasQueCambian(sugerencia);
  const vista = fila && !sinVentana ? pagosEnVista(fila, pago.pago_id, contexto) : [];
  const elementos = fila ? elementosDeLinea(fila, vista) : [];
  const puedeActuar = puedeEditar && !guardando && !pendiente && !!filaBase;

  return (
    <section aria-label="Panel del pago" className="cortes-panel">
      <header className="cortes-panel-cab">
        <div>
          <h2>{nombreComisionista(filaResumen)}</h2>
          <p>
            {filaResumen.sociedad} · {filaResumen.division_code ?? "Sin división"} ·{" "}
            {sinVentana ? "pago sin ventana" : `pago ${rangoCorto(pago.ini!, pago.fin!)}`}
          </p>
        </div>
        <div className="cortes-panel-cab-acc">
          {pendiente ? <span className="cortes-estado-guardado">Cambio sin guardar…</span> : null}
          {guardando ? <span className="cortes-estado-guardado">Guardando…</span> : null}
          <Pastilla estado={pago.estado} />
          <button aria-label="Cerrar el panel" className="cortes-cerrar" onClick={onCerrar} type="button">
            ×
          </button>
        </div>
      </header>

      <div className="cortes-tabs" role="tablist">
        <button aria-selected={tab === "cortes"} onClick={() => setTab("cortes")} role="tab" type="button">
          Cortes
        </button>
        <button aria-selected={tab === "detalle"} disabled={sinVentana} onClick={() => setTab("detalle")} role="tab" type="button">
          Detalle por producto
        </button>
      </div>

      {aviso ? (
        <p className="cortes-aviso" role="alert">
          {aviso}
        </p>
      ) : null}

      {tab === "detalle" ? (
        <div className="cortes-bloque">
          {detalleError ? <p className="hydro-error">{detalleError}</p> : null}
          {!detalle && !detalleError ? <p className="hydro-muted">Cargando el detalle…</p> : null}
          {detalle ? (
            <>
              <p className="cortes-nota">
                Productos cobrados entre {fechaCorta(detalle.ini)} y {fechaCorta(detalle.fin)}, la ventana de este pago.
                Si se mueve un corte, esta tabla cambia con él.
              </p>
              <div className="hydro-table-wrap">
                <table className="cortes-tabla">
                  <colgroup>
                    <col style={{ width: "15%" }} />
                    <col style={{ width: "15%" }} />
                    <col style={{ width: "38%" }} />
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>CEDIS</th>
                      <th>Tipo de venta</th>
                      <th>Producto</th>
                      <th className="n">Vendido</th>
                      <th className="n">Comisión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalle.filas.map((f, i) => (
                      <tr key={`${f.cedis}-${f.oficina}-${f.tipo_venta}-${f.matnr}-${i}`}>
                        <td>{f.cedis ?? "—"}</td>
                        <td>{f.tipo_venta ?? "—"}</td>
                        <td title={f.matnr}>{f.descripcion ?? f.matnr}</td>
                        <td className="n">
                          {f.cantidad_venta_total === null ? "—" : numero.format(f.cantidad_venta_total)}{" "}
                          <small>{f.unidad_venta}</small>
                        </td>
                        <td className="n">{pesos(f.comision_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>Total</td>
                      <td className="n">{pesos(detalle.comision_total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
          {error ? <p className="hydro-error">{error}</p> : null}

          {sinVentana ? (
            <div className="cortes-bloque">
              <Cifras pago={pago} />
              <div className="cortes-caja is-aviso">
                <h3>Pago sin ventana</h3>
                <p>
                  El texto de este pago no trae fechas que se puedan leer, así que no sabemos qué cobros cubre. Pagado{" "}
                  {pesos(pago.pagado)}, documento {pago.docs.join(", ")}. Poder fijar su inicio y su fin llega más
                  adelante.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="cortes-bloque">
                {!datos && !error ? <p className="hydro-muted">Cargando la línea de tiempo…</p> : null}
                {fila ? (
                  <>
                    <div className="cortes-linea-scroll">
                      <div className="cortes-linea">
                        {elementos.map((el, i) => {
                          if (el.tipo === "corte") {
                            const movible = puedeEditar && !el.congelado;
                            const limites = filaBase ? limitesDeCorte(filaBase, el.izq) : null;
                            return (
                              <div className={`cortes-corte${el.congelado ? " is-congelado" : ""}`} key={`c${i}`}>
                                <span>Corte</span>
                                <b>{fechaConDia(el.fecha)}</b>
                                {el.congelado ? <small>Congelado</small> : null}
                                {movible ? (
                                  <span className="cortes-corte-flechas">
                                    <button
                                      aria-label="Mover el corte un día antes"
                                      disabled={guardando || !limites || el.fecha <= limites.min}
                                      onClick={() => moverCorte(el.izq, -1)}
                                      type="button"
                                    >
                                      ◀
                                    </button>
                                    <button
                                      aria-label="Mover el corte un día después"
                                      disabled={guardando || !limites || el.fecha >= limites.max}
                                      onClick={() => moverCorte(el.izq, 1)}
                                      type="button"
                                    >
                                      ▶
                                    </button>
                                  </span>
                                ) : null}
                                {sugerencia?.cambios.some((c) => c.borde === "fin" && c.pago_id === el.izq) ? (
                                  <small className="cortes-sugerido">
                                    Sugerido: {fechaConDia(sugerencia.cambios.find((c) => c.borde === "fin" && c.pago_id === el.izq)!.a)}
                                  </small>
                                ) : null}
                              </div>
                            );
                          }
                          if (el.tipo === "traslape") {
                            return (
                              <div className="cortes-corte is-traslape" key={`t${i}`}>
                                <span>Traslape</span>
                                <b>{rangoCorto(el.ini, el.fin)}</b>
                                <small>Días en dos pagos</small>
                              </div>
                            );
                          }
                          if (el.tipo === "hueco") {
                            const dd: string[] = [];
                            for (let d = el.ini; d <= el.fin; d = sumarDias(d, 1)) dd.push(d);
                            return (
                              <div className={`cortes-tramo is-hueco${el.cierre ? " is-cierre" : ""}`} key={`h${i}`}>
                                <div className="cortes-tramo-cab">
                                  <b>{el.cierre ? "Cierre de mes" : "Sin pago"}</b>
                                  <span className={`cortes-pastilla ${el.cierre ? "is-cons" : "is-sinv"}`}>
                                    {el.cierre ? "Va con el pago siguiente" : "Cobros sin pago"}
                                  </span>
                                </div>
                                <dl className="cortes-cifras">
                                  <div>
                                    <dt>Comisión</dt>
                                    <dd>{pesos(el.comision)}</dd>
                                  </div>
                                </dl>
                                <div className="cortes-dias">
                                  {dd.map((d) => (
                                    <div className="cortes-dia" key={d}>
                                      <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                      {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          const p = el.pago;
                          const dd: string[] = [];
                          for (let d = p.ini!; d <= p.fin!; d = sumarDias(d, 1)) dd.push(d);
                          const indice = vista.findIndex((v) => v.pago_id === p.pago_id);
                          return (
                            <div
                              className={`cortes-tramo${p.pago_id === pago.pago_id ? " is-actual" : ""}`}
                              key={p.pago_id}
                              title={`Documento ${p.docs.join(", ")}`}
                            >
                              <div className="cortes-tramo-cab">
                                <b>{rangoCorto(p.ini!, p.fin!)}</b>
                                <Pastilla estado={p.estado} />
                              </div>
                              <Cifras pago={p} />
                              <div className="cortes-dias">
                                {dd.map((d) => (
                                  <div
                                    className={`cortes-dia c${indice % 3}${marcados.has(d) ? " is-mv" : ""}`}
                                    key={d}
                                  >
                                    <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                    {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="cortes-acciones">
                      <button className="cortes-boton" onClick={() => setContexto((c) => (c === 1 ? 2 : 1))} type="button">
                        {contexto === 1 ? "Ampliar contexto (±2 pagos)" : "Reducir contexto (±1 pago)"}
                      </button>
                      {pago.ajustado && puedeEditar ? (
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("restablecer", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Volver a la ventana del texto
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>

              {pago.sin_calculo ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-aviso">
                    <h3>Pago sin cálculo</h3>
                    <p>No hay comisión calculada para este comisionista y división en la ventana del pago.</p>
                  </div>
                </div>
              ) : null}

              {sugerencia ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-sugerencia">
                    <div className="cortes-fichas">
                      <span className={`cortes-ficha${sugerencia.unica ? " is-ok" : " is-aviso"}`}>
                        {sugerencia.unica ? "Única opción exacta" : "Varias opciones, la de menor cambio"}
                      </span>
                    </div>
                    <h3>Sugerencia: {cortesMovidos(sugerencia).map(describirMovimiento).join(" y ")}</h3>
                    <div className="cortes-antes-despues">
                      {sugerencia.afectados.map((a) => (
                        <div key={a.pago_id}>
                          <span>{rangoCorto(a.ini_antes, a.fin_antes)}</span>
                          <b>
                            <s>{textoDiferencia(a.diferencia_antes)}</s> → {textoDiferencia(a.diferencia_despues)}
                          </b>
                        </div>
                      ))}
                    </div>
                    {puedeEditar ? (
                      <div className="cortes-acciones">
                        <button
                          className="cortes-boton is-primario"
                          disabled={!puedeActuar}
                          onClick={() => void editar("aplicar", { pago_id: pago.pago_id, cambios: sugerencia.cambios })}
                          type="button"
                        >
                          Aplicar
                        </button>
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("descartar", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Descartar
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {pago.estado === "sin" && !pago.sin_calculo && !pendiente ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-error">
                    <h3>Sin explicación</h3>
                    <p>
                      {pago.descartada
                        ? "Descartaron la sugerencia de este pago."
                        : "Ningún ajuste de hasta 3 días en los cortes cuadra este pago."}
                    </p>
                    {pago.descartada && puedeEditar ? (
                      <div className="cortes-acciones">
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("recuperar", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Recuperar la sugerencia
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="cortes-bloque cortes-pie">
                <button className="cortes-boton is-primario" disabled title="Disponible en la siguiente fase" type="button">
                  Consolidar este pago
                </button>
                <span>
                  {puedeEditar
                    ? "Consolidar se habilita en la siguiente fase."
                    : "Solo lectura: tu rol no puede editar los cortes."}
                </span>
              </div>

              <details className="cortes-historial" onToggle={(e) => void abrirHistorial((e.target as HTMLDetailsElement).open)}>
                <summary>Historial de esta fila</summary>
                {historial === null ? <p className="hydro-muted">Cargando…</p> : null}
                {historial && !historial.length ? <p className="hydro-muted">Sin cambios todavía.</p> : null}
                {historial?.length ? (
                  <ul>
                    {historial.map((e, i) => (
                      <li key={`${e.ts}-${i}`}>
                        <time>{e.ts ? formatoMomento.format(new Date(e.ts)) : "—"}</time>
                        <span>
                          {e.usuario ?? "—"} {describirEvento(e)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
