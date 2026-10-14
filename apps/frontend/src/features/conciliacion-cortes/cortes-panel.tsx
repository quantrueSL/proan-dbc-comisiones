"use client";

// Panel de un pago: línea de tiempo con los cortes, sugerencia o advertencia y,
// aparte, el detalle por producto de su ventana. Solo lectura (fase 3): los
// botones de aplicar y consolidar están deshabilitados hasta que exista el
// estado guardado (Firestore).

import { useEffect, useMemo, useState } from "react";
import type {
  CortesDetalleResponse,
  CortesFila,
  CortesFilaResponse,
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
  onCerrar: () => void;
};

const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });

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

export function CortesPanel({ mes, filaResumen, pagoId, onCerrar }: Props) {
  const [tab, setTab] = useState<"cortes" | "detalle">("cortes");
  const [contexto, setContexto] = useState(1);
  const [datos, setDatos] = useState<CortesFilaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<CortesDetalleResponse | null>(null);
  const [detalleError, setDetalleError] = useState<string | null>(null);

  // Cambió el pago: se vuelve a la pestaña de cortes y se vuelve a pedir la fila.
  useEffect(() => {
    let vigente = true;
    setTab("cortes");
    setDatos(null);
    setDetalle(null);
    setError(null);
    setDetalleError(null);
    pedir<CortesFilaResponse>("/api/comisionesbi/cortes/fila", {
      mes,
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code
    })
      .then((r) => vigente && setDatos(r))
      .catch((e) => vigente && setError(e instanceof Error ? e.message : "No se pudo cargar el pago."));
    return () => {
      vigente = false;
    };
  }, [mes, filaResumen.fila_id, pagoId, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  const fila = datos?.fila ?? null;
  const pago = (fila ?? filaResumen).pagos.find((p) => p.pago_id === pagoId) ?? null;
  const dias = useMemo(() => new Map(datos?.dias ?? []), [datos]);

  // El detalle por producto se pide solo al abrir su pestaña.
  useEffect(() => {
    if (tab !== "detalle" || !pago || !pago.ini || !pago.fin || detalle) return;
    let vigente = true;
    pedir<CortesDetalleResponse>("/api/comisionesbi/cortes/detalle", {
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code,
      ini: pago.ini,
      fin: pago.fin
    })
      .then((r) => vigente && setDetalle(r))
      .catch((e) => vigente && setDetalleError(e instanceof Error ? e.message : "No se pudo cargar el detalle."));
    return () => {
      vigente = false;
    };
  }, [tab, pago, detalle, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  if (!pago) return null;
  const sinVentana = pago.ini === null || pago.fin === null;
  const sugerencia = pago.estado === "sug" ? pago.sugerencia : null;
  const marcados = diasQueCambian(sugerencia);
  const vista = fila && !sinVentana ? pagosEnVista(fila, pago.pago_id, contexto) : [];
  const elementos = fila ? elementosDeLinea(fila, vista) : [];

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
                  {pesos(pago.pagado)}, documento {pago.docs.join(", ")}. Poder fijar su inicio y su fin llega con la
                  edición de cortes.
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
                            return (
                              <div className={`cortes-corte${el.congelado ? " is-congelado" : ""}`} key={`c${i}`}>
                                <span>Corte</span>
                                <b>{fechaConDia(el.fecha)}</b>
                                {el.congelado ? <small>Congelado</small> : null}
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
                              <div className="cortes-tramo is-hueco" key={`h${i}`}>
                                <div className="cortes-tramo-cab">
                                  <b>Sin pago</b>
                                  <span className="cortes-pastilla is-sinv">Cobros sin pago</span>
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
                    <h3>
                      Sugerencia:{" "}
                      {cortesMovidos(sugerencia).map(describirMovimiento).join(" y ")}
                    </h3>
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
                    <div className="cortes-acciones">
                      <button className="cortes-boton is-primario" disabled title="Disponible cuando se pueda guardar" type="button">
                        Aplicar
                      </button>
                      <button className="cortes-boton" disabled title="Disponible cuando se pueda guardar" type="button">
                        Descartar
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {pago.estado === "sin" && !pago.sin_calculo ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-error">
                    <h3>Sin explicación</h3>
                    <p>Ningún ajuste de hasta 3 días en los cortes cuadra este pago.</p>
                  </div>
                </div>
              ) : null}

              <div className="cortes-bloque cortes-pie">
                <button className="cortes-boton is-primario" disabled title="Disponible cuando se pueda guardar" type="button">
                  Consolidar este pago
                </button>
                <span>Vista de solo lectura: los cortes y la consolidación se habilitan en la siguiente fase.</span>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
