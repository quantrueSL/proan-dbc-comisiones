"use client";

// Módulo 3 · Conciliación documental -- el menos avanzado del proyecto (ver
// comisionesbi/conciliacion_engine.py): se identificó la fuente candidata
// (FBL1N → sap_bsik_open_items) pero no se ha validado ni construido nada
// todavía; falta además la relación comisionista ↔ oficinas de venta y el
// rango de proveedor de comisionistas (tarea #13). Esta pantalla ya llama de
// verdad a POST /api/comisionesbi/reconciliation -- hoy responde 501, así que
// se muestra el aviso más una vista previa maestro-detalle con datos de
// EJEMPLO (marcados como tal), inspirada en el patrón de aprobación de
// Hidrocarburos (evidencia + confianza del match).

import { Fragment, useEffect, useMemo, useState } from "react";
import { FiltersSidebar } from "@/components/filters-sidebar";
import { EtiquetaVistaPrevia, ModuloEnConstruccion } from "@/components/modulo-en-construccion";
import type { ReconciliationDetail, ReconciliationFilters, ReconciliationItem, ReconciliationResponse } from "@/types/comisiones";

type Props = {
  initialBlockedMessage: string | null;
  initialError: string | null;
  initialResponse: ReconciliationResponse | null;
};

const money = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" });

function formatMoney(value: number | null) {
  return value === null ? "—" : `${money.format(value)} MXN`;
}

function formatDate(value: string | null) {
  return value ? date.format(new Date(`${value.slice(0, 10)}T12:00:00`)) : "—";
}

const CONFIANZA_BADGE: Record<ReconciliationItem["confianza"], string> = {
  alta: "is-ok",
  media: "is-review",
  baja: "is-review"
};
const CONFIANZA_LABEL: Record<ReconciliationItem["confianza"], string> = { alta: "Alta", media: "Media", baja: "Baja" };
const ESTADO_LABEL: Record<ReconciliationItem["estado"], string> = { conciliado: "Conciliado", revisar: "Por revisar", pendiente: "Pendiente" };

// Datos de EJEMPLO -- ilustran la vista maestro-detalle propuesta para
// conciliación (evidencia + confianza del match documento de pago ↔ factura
// del comisionista). No provienen de BigQuery. Ver README.md, "Bloqueantes".
const FILAS_EJEMPLO: ReconciliationItem[] = [
  { id: "1", comisionista: "Comisionista 1", proveedor_id: "P-00123", factura_serie: "A", factura_folio: "1045", periodo: "2026-06", monto_factura: 24500, monto_pagado: 24500, confianza: "alta", estado: "conciliado" },
  { id: "2", comisionista: "Comisionista 2", proveedor_id: "P-00147", factura_serie: "A", factura_folio: "0892", periodo: "2026-06", monto_factura: 20750, monto_pagado: 19000, confianza: "media", estado: "revisar" },
  { id: "3", comisionista: "Comisionista 3", proveedor_id: "P-00198", factura_serie: "B", factura_folio: "0231", periodo: "2026-06", monto_factura: 47500, monto_pagado: null, confianza: "baja", estado: "pendiente" }
];

const DETALLE_EJEMPLO: Record<string, ReconciliationDetail> = {
  "1": {
    ...FILAS_EJEMPLO[0],
    documento_pago: "1400002233",
    fecha_pago: "2026-06-18",
    diferencia: 0,
    notas: null,
    evidencia: [
      { etiqueta: "Documento de pago (FBL1N)", valor: "1400002233" },
      { etiqueta: "Coincidencia", valor: "Folio + importe exactos" },
      { etiqueta: "Cuenta de proveedor", valor: "P-00123" }
    ]
  },
  "2": {
    ...FILAS_EJEMPLO[1],
    documento_pago: "1400002298",
    fecha_pago: "2026-06-22",
    diferencia: 1750,
    notas: "El pago cubre dos facturas del mismo periodo; falta prorratear.",
    evidencia: [
      { etiqueta: "Documento de pago (FBL1N)", valor: "1400002298" },
      { etiqueta: "Coincidencia", valor: "Solo importe (folio no referenciado)" },
      { etiqueta: "Diferencia", valor: "1,750 MXN por revisar" }
    ]
  },
  "3": {
    ...FILAS_EJEMPLO[2],
    documento_pago: null,
    fecha_pago: null,
    diferencia: null,
    notas: "Sin documento de pago identificado todavía.",
    evidencia: [{ etiqueta: "Documento de pago (FBL1N)", valor: "Sin match" }]
  }
};

const EJEMPLO: ReconciliationResponse = {
  filas: FILAS_EJEMPLO,
  detalle: DETALLE_EJEMPLO,
  conciliados: 1,
  por_revisar: 1,
  pendientes: 1
};

export function ConciliacionWorkspace({ initialBlockedMessage, initialError, initialResponse }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [comisionista, setComisionista] = useState("");
  const [startPeriod, setStartPeriod] = useState("");
  const [endPeriod, setEndPeriod] = useState("");
  const [response, setResponse] = useState(initialResponse);
  const [blockedMessage, setBlockedMessage] = useState(initialBlockedMessage);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const body: ReconciliationFilters = {
        provider_id: comisionista || null,
        start_period: startPeriod || "",
        end_period: endPeriod || ""
      };
      const res = await fetch("/api/comisionesbi/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await res.json().catch(() => null)) as (ReconciliationResponse & { detail?: string }) | null;
      if (res.status === 501) {
        setBlockedMessage(payload?.detail || "Este módulo todavía no está disponible.");
        setResponse(null);
        setSelectedId(null);
        return;
      }
      if (!res.ok) throw new Error(payload?.detail || "No se pudo cargar la conciliación.");
      setBlockedMessage(null);
      setResponse(payload as ReconciliationResponse);
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar la conciliación.");
    } finally {
      setLoading(false);
    }
  }

  const datos = response ?? (blockedMessage ? EJEMPLO : null);
  const esEjemplo = !response && Boolean(blockedMessage);
  const detalle = useMemo(() => (selectedId && datos ? datos.detalle[selectedId] : null), [selectedId, datos]);

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={[comisionista, startPeriod, endPeriod].filter(Boolean).length}
        info={
          <>
            <p>
              Relaciona las facturas de cada comisionista con sus documentos de pago (FBL1N), para
              el cumplimiento SAT sobre pago de comisiones.
            </p>
            <h3>Cómo leer la confianza</h3>
            <ul>
              <li>Alta: folio e importe coinciden exactamente.</li>
              <li>Media: coincide el importe, sin folio referenciado.</li>
              <li>Baja / pendiente: sin documento de pago identificado.</li>
            </ul>
          </>
        }
        infoTitle="Conciliación documental"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={null}
      >
        <label>
          Comisionista / proveedor
          <input onChange={(e) => setComisionista(e.target.value)} placeholder="Nombre o ID…" type="search" value={comisionista} />
        </label>
        <label>
          Desde (periodo)
          <input onChange={(e) => setStartPeriod(e.target.value)} type="month" value={startPeriod} />
        </label>
        <label>
          Hasta (periodo)
          <input onChange={(e) => setEndPeriod(e.target.value)} type="month" value={endPeriod} />
        </label>
        <div className="filters-sidebar-actions">
          <button className="hydro-button" disabled={loading} onClick={load} type="button">
            {loading ? "Actualizando…" : "Aplicar filtros"}
          </button>
        </div>
      </FiltersSidebar>

      <div className="approval-page">
        {error ? (
          <p className="approval-error" role="alert">
            {error}
          </p>
        ) : null}

        <header className="operational-summary">
          <div className="operational-summary-title">
            <p>Cumplimiento SAT</p>
            <h1>Conciliación documental</h1>
            <span>Facturas de comisionistas contra sus documentos de pago.</span>
          </div>
          {datos ? (
            <section className="approval-kpis" aria-label="Indicadores de conciliación">
              <div>
                <span>Conciliados</span>
                <strong>{datos.conciliados}</strong>
              </div>
              <div>
                <span>Por revisar</span>
                <strong>{datos.por_revisar}</strong>
              </div>
              <div>
                <span>Pendientes</span>
                <strong>{datos.pendientes}</strong>
              </div>
            </section>
          ) : null}
        </header>

        {blockedMessage ? <ModuloEnConstruccion motivo={blockedMessage} /> : null}

        {datos ? (
          <section className="approval-content">
            <div className="approval-table-area">
              <div className="approval-table-heading">
                <div>
                  <p>Facturas de comisionistas</p>
                  <h2>Conciliación {esEjemplo ? <EtiquetaVistaPrevia /> : null}</h2>
                </div>
              </div>
              <div className="approval-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Comisionista</th>
                      <th>Factura</th>
                      <th>Periodo</th>
                      <th>Monto factura</th>
                      <th>Monto pagado</th>
                      <th>Confianza</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.filas.map((row) => (
                      <tr
                        aria-label={`Revisar conciliación ${row.factura_serie || ""}${row.factura_folio}`}
                        className={selectedId === row.id ? "is-selected" : ""}
                        key={row.id}
                        onClick={() => setSelectedId(row.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(row.id);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <td>{row.comisionista}</td>
                        <td>
                          {row.factura_serie || ""}
                          {row.factura_folio}
                        </td>
                        <td>{row.periodo}</td>
                        <td>{formatMoney(row.monto_factura)}</td>
                        <td>{formatMoney(row.monto_pagado)}</td>
                        <td>
                          <span className={`hydro-badge ${CONFIANZA_BADGE[row.confianza]}`}>{CONFIANZA_LABEL[row.confianza]}</span>
                        </td>
                        <td>{ESTADO_LABEL[row.estado]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!datos.filas.length ? (
                  <div className="approval-empty">
                    <span aria-hidden="true" className="approval-empty-icon">
                      ✓
                    </span>
                    <b>Sin resultados</b>
                    <span>Prueba con otros filtros.</span>
                  </div>
                ) : null}
              </div>
            </div>

            {selectedId ? <button aria-label="Cerrar detalle" className="approval-detail-backdrop" onClick={() => setSelectedId(null)} type="button" /> : null}
            <aside aria-label="Detalle de conciliación" aria-modal={selectedId ? "true" : undefined} className={`approval-detail${selectedId ? " is-open" : ""}`} role={selectedId ? "dialog" : undefined}>
              {detalle ? (
                <>
                  <div className="approval-detail-header">
                    <div>
                      <p>
                        {detalle.comisionista} · {ESTADO_LABEL[detalle.estado]}
                      </p>
                      <h2>
                        {detalle.factura_serie || ""}
                        {detalle.factura_folio}
                      </h2>
                    </div>
                    <button aria-label="Cerrar detalle" onClick={() => setSelectedId(null)} type="button">
                      ×
                    </button>
                  </div>

                  <div className="approval-decision-summary" aria-label="Resumen de conciliación">
                    <div>
                      <span>Confianza</span>
                      <strong className={detalle.confianza === "alta" ? "is-good" : "is-warning"}>{CONFIANZA_LABEL[detalle.confianza]}</strong>
                    </div>
                    <div>
                      <span>Pago</span>
                      <strong className={detalle.monto_pagado !== null ? "is-good" : "is-warning"}>{detalle.monto_pagado !== null ? "Identificado" : "Sin identificar"}</strong>
                    </div>
                    <div>
                      <span>Diferencia</span>
                      <strong className={!detalle.diferencia ? "is-good" : "is-warning"}>{detalle.diferencia ? formatMoney(detalle.diferencia) : "Sin diferencia"}</strong>
                    </div>
                  </div>

                  <dl className="approval-invoice-data">
                    <dt>Proveedor (comisionista)</dt>
                    <dd>{detalle.proveedor_id}</dd>
                    <dt>Periodo</dt>
                    <dd>{detalle.periodo}</dd>
                    <dt>Monto factura</dt>
                    <dd>{formatMoney(detalle.monto_factura)}</dd>
                    <dt>Monto pagado</dt>
                    <dd>{formatMoney(detalle.monto_pagado)}</dd>
                    <dt>Fecha de pago</dt>
                    <dd>{formatDate(detalle.fecha_pago)}</dd>
                  </dl>

                  <div className="approval-audit">
                    <p>Evidencia del match</p>
                    <dl>
                      {detalle.evidencia.map((item) => (
                        <Fragment key={item.etiqueta}>
                          <dt>{item.etiqueta}</dt>
                          <dd>{item.valor}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>

                  {detalle.notas ? (
                    <div className="approval-audit">
                      <p>Notas</p>
                      <dl>
                        <dt>Observación</dt>
                        <dd>{detalle.notas}</dd>
                      </dl>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="approval-detail-placeholder">
                  <span>Selecciona una fila para revisar la evidencia</span>
                </div>
              )}
            </aside>
          </section>
        ) : null}
      </div>
    </div>
  );
}
