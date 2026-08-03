"use client";

// Módulo 2 · Comisiones -- el cálculo real está bloqueado (ver
// comisionesbi/comisiones_engine.py): falta el export de GS03 (SETs de
// producto) y la tabla oficial de tarifas (ZSDFI_001). Esta pantalla ya está
// conectada de verdad a POST /api/comisionesbi/report -- hoy responde 501 con
// el motivo, así que se muestra ese aviso más una vista previa con datos de
// EJEMPLO (marcados como tal) para validar la UX mientras se resuelven los
// bloqueantes (tareas #3 y #10 del proyecto).

import { useState } from "react";
import { FiltersSidebar } from "@/components/filters-sidebar";
import { EtiquetaVistaPrevia, ModuloEnConstruccion } from "@/components/modulo-en-construccion";
import type { CedisRow, ComisionesCatalog, DivisionRow, ReportFilters, ReportResponse } from "@/types/comisiones";

type Props = {
  initialBlockedMessage: string | null;
  initialCatalog: ComisionesCatalog;
  initialError: string | null;
  initialReport: ReportResponse | null;
};

const money = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("es-MX");

function formatMoney(value: number) {
  return `${money.format(value)} MXN`;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="hydro-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// Datos de EJEMPLO -- ilustran cómo se vería el reporte una vez resueltos los
// bloqueantes. No provienen de BigQuery. Ver README.md, "Bloqueantes".
const EJEMPLO: ReportResponse = {
  filas: [
    { division: "Aves", cedis: "CEDIS Culiacán", comisionista: "Comisionista 1", vendido: 1240000, facturado: 1180000, cobrado: 980000, comision_devengada: 29500, comision_pagable: 24500 },
    { division: "Aves", cedis: "CEDIS Mazatlán", comisionista: "Comisionista 2", vendido: 860000, facturado: 830000, cobrado: 830000, comision_devengada: 20750, comision_pagable: 20750 },
    { division: "Cerdo", cedis: "CEDIS Culiacán", comisionista: "Comisionista 1", vendido: 540000, facturado: 510000, cobrado: 400000, comision_devengada: 12750, comision_pagable: 10000 },
    { division: "Balanceado", cedis: "CEDIS Los Mochis", comisionista: "Comisionista 3", vendido: 2100000, facturado: 2050000, cobrado: 1900000, comision_devengada: 51250, comision_pagable: 47500 }
  ],
  vendido_total: 4740000,
  facturado_total: 4570000,
  cobrado_total: 4110000,
  comision_pagable_total: 102750
};

function divisionLabel(row: DivisionRow): string {
  const candidate = row.division_name ?? row.business_area_name ?? row.name ?? row.sales_division;
  return candidate === null || candidate === undefined ? JSON.stringify(row) : String(candidate);
}

export function ComisionesWorkspace({ initialBlockedMessage, initialCatalog, initialError, initialReport }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [division, setDivision] = useState("");
  const [cedis, setCedis] = useState("");
  const [startPeriod, setStartPeriod] = useState("");
  const [endPeriod, setEndPeriod] = useState("");
  const [report, setReport] = useState(initialReport);
  const [blockedMessage, setBlockedMessage] = useState(initialBlockedMessage);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const body: ReportFilters = {
        division: division || null,
        cedis: cedis || null,
        start_period: startPeriod || "",
        end_period: endPeriod || ""
      };
      const response = await fetch("/api/comisionesbi/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as (ReportResponse & { detail?: string }) | null;
      if (response.status === 501) {
        setBlockedMessage(payload?.detail || "Este módulo todavía no está disponible.");
        setReport(null);
        return;
      }
      if (!response.ok) {
        throw new Error(payload?.detail || "No se pudo generar el reporte de comisión.");
      }
      setBlockedMessage(null);
      setReport(payload as ReportResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el reporte de comisión.");
    } finally {
      setLoading(false);
    }
  }

  const datos = report ?? (blockedMessage ? EJEMPLO : null);
  const esEjemplo = !report && Boolean(blockedMessage);
  const activeFilterCount = [division, cedis, startPeriod, endPeriod].filter(Boolean).length;

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={activeFilterCount}
        info={
          <>
            <p>
              Comisión devengada y pagable por comisionista, calculada solo sobre lo cobrado o
              compensado (nunca sobre lo vendido/facturado) -- ver el borrador técnico, sección 6.
            </p>
            <h3>Por qué dice &ldquo;vista previa&rdquo;</h3>
            <ul>
              <li>Falta el export de GS03 (SETs de producto).</li>
              <li>Falta la tabla oficial de tarifas (TX ZSDFI_001).</li>
            </ul>
          </>
        }
        infoTitle="Comisiones"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={null}
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
          Desde (periodo)
          <input onChange={(e) => setStartPeriod(e.target.value)} type="month" value={startPeriod} />
        </label>
        <label>
          Hasta (periodo)
          <input onChange={(e) => setEndPeriod(e.target.value)} type="month" value={endPeriod} />
        </label>
        <div className="filters-sidebar-actions">
          <button className="hydro-button" disabled={loading} onClick={load} type="button">
            {loading ? "Calculando…" : "Calcular"}
          </button>
          <button
            className="hydro-link-button"
            onClick={() => {
              setDivision("");
              setCedis("");
              setStartPeriod("");
              setEndPeriod("");
            }}
            type="button"
          >
            Restablecer
          </button>
        </div>
      </FiltersSidebar>

      <div className="hydro-page" data-module="comisiones">
        {error ? <p className="hydro-error">{error}</p> : null}

        <header className="operational-summary">
          <div className="operational-summary-title">
            <p>Cálculo de comisión</p>
            <h1>Comisiones</h1>
            <span>Comisión devengada y pagable por comisionista, según lo cobrado/compensado por CEDIS.</span>
          </div>
          {datos ? (
            <section className="hydro-module-kpis" aria-label="Indicadores de comisión">
              <Kpi label="Vendido" value={formatMoney(datos.vendido_total)} />
              <Kpi label="Facturado" value={formatMoney(datos.facturado_total)} />
              <Kpi label="Cobrado" value={formatMoney(datos.cobrado_total)} />
              <Kpi label="Comisión pagable" value={formatMoney(datos.comision_pagable_total)} />
            </section>
          ) : null}
        </header>

        {blockedMessage ? <ModuloEnConstruccion motivo={blockedMessage} /> : null}

        {datos ? (
          <section className="hydro-table-card">
            <div className="hydro-table-title">
              <div>
                <h2>Comisión por comisionista</h2>
                <span>
                  {number.format(datos.filas.length)} filas{esEjemplo ? " · " : null}
                </span>
                {esEjemplo ? <EtiquetaVistaPrevia /> : null}
              </div>
            </div>
            <div className="hydro-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>División</th>
                    <th>CEDIS</th>
                    <th>Comisionista</th>
                    <th>Vendido</th>
                    <th>Facturado</th>
                    <th>Cobrado</th>
                    <th>Comisión devengada</th>
                    <th>Comisión pagable</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.filas.map((row, index) => (
                    <tr key={index}>
                      <td>{row.division}</td>
                      <td>{row.cedis}</td>
                      <td>{row.comisionista}</td>
                      <td>{formatMoney(row.vendido)}</td>
                      <td>{formatMoney(row.facturado)}</td>
                      <td>{formatMoney(row.cobrado)}</td>
                      <td>{formatMoney(row.comision_devengada)}</td>
                      <td>{formatMoney(row.comision_pagable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
