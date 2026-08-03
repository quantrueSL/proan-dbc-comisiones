"use client";

// Módulo 0 · Flujo de producto -- hoy es el catálogo de dimensión ya resuelto
// y validado (división + CEDIS, ver Datos/Comisiones_DBC_Borrador_Tecnico.md,
// sección 3). Las 4 capas del flujo real (traspasos → vendido → facturado →
// cobrado/compensado) todavía no tienen endpoint: dependen de incorporar
// MB51/sap_mseg (tarea #9) y de las demás fuentes por CEDIS. En vez de simular
// esas cifras, esta pantalla es honesta sobre lo que sí existe hoy y deja un
// aviso de lo que falta.

import { useMemo, useState } from "react";
import { FiltersSidebar } from "@/components/filters-sidebar";
import type { CedisRow, ComisionesCatalog } from "@/types/comisiones";

type Props = {
  initialCatalog: ComisionesCatalog;
  initialError: string | null;
};

const number = new Intl.NumberFormat("es-MX");

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="hydro-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function uniqueSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v && v.trim())))).sort((a, b) => a.localeCompare(b, "es"));
}

export function FlujoProductoWorkspace({ initialCatalog, initialError }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [oficina, setOficina] = useState("");
  const [tipoVenta, setTipoVenta] = useState("");

  const { divisiones, cedis } = initialCatalog;

  const oficinas = useMemo(() => uniqueSorted(cedis.map((r) => r.oficina)), [cedis]);
  const tiposVenta = useMemo(() => uniqueSorted(cedis.map((r) => r.tipo_venta)), [cedis]);
  const sectores = useMemo(() => uniqueSorted(cedis.map((r) => r.sector)), [cedis]);

  const filasFiltradas = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return cedis.filter((row) => {
      if (oficina && row.oficina !== oficina) return false;
      if (tipoVenta && row.tipo_venta !== tipoVenta) return false;
      if (!texto) return true;
      return [row.cedis, row.sector, row.almacen, row.oficina, row.tipo_venta]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(texto));
    });
  }, [cedis, busqueda, oficina, tipoVenta]);

  const activeFilterCount = [busqueda, oficina, tipoVenta].filter(Boolean).length;
  const divisionColumns = divisiones.length ? Object.keys(divisiones[0]) : [];

  function reset() {
    setBusqueda("");
    setOficina("");
    setTipoVenta("");
  }

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={activeFilterCount}
        info={
          <>
            <p>
              Catálogo de división de producto y CEDIS que alimenta los filtros del resto de la
              plataforma. Es la base de dimensión (D20_DIMENSION.dm_business_area / dm_cedis), no
              todavía el flujo transaccional por etapa.
            </p>
            <h3>Qué falta para el flujo completo</h3>
            <ul>
              <li>Traspasos (entradas) vía MB51 / sap_mseg.</li>
              <li>Definición de SETs de producto (marca/línea) vía export de GS03.</li>
            </ul>
          </>
        }
        infoTitle="Flujo de producto"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={null}
      >
        <label>
          Buscar
          <input onChange={(e) => setBusqueda(e.target.value)} placeholder="CEDIS, sector, almacén…" type="search" value={busqueda} />
        </label>
        <label>
          Oficina
          <select onChange={(e) => setOficina(e.target.value)} value={oficina}>
            <option value="">Todas</option>
            {oficinas.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo de venta
          <select onChange={(e) => setTipoVenta(e.target.value)} value={tipoVenta}>
            <option value="">Todos</option>
            {tiposVenta.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="filters-sidebar-actions">
          <button className="hydro-link-button" onClick={reset} type="button">
            Restablecer
          </button>
        </div>
      </FiltersSidebar>

      <div className="hydro-page" data-module="flujo-producto">
        {initialError ? <p className="hydro-error">{initialError}</p> : null}

        <header className="operational-summary">
          <div className="operational-summary-title">
            <p>Catálogo de dimensión</p>
            <h1>Flujo de producto</h1>
            <span>División de producto y CEDIS por sector, almacén, oficina y tipo de venta.</span>
          </div>
          <section className="hydro-module-kpis" aria-label="Indicadores de catálogo">
            <Kpi label="Divisiones" value={number.format(divisiones.length)} />
            <Kpi label="CEDIS" value={number.format(cedis.length)} />
            <Kpi label="Oficinas" value={number.format(oficinas.length)} />
            <Kpi label="Sectores" value={number.format(sectores.length)} />
          </section>
        </header>

        <div className="hydro-unavailable" role="note">
          <div>
            <b>El flujo por etapa todavía no está aquí</b>
            <p>
              Traspasos → vendido → facturado → cobrado/compensado por CEDIS depende de incorporar
              MB51/sap_mseg y de otras fuentes pendientes — ver el borrador técnico del proyecto.
            </p>
          </div>
        </div>

        <section className="hydro-table-card">
          <div className="hydro-table-title">
            <div>
              <h2>CEDIS</h2>
              <span>{number.format(filasFiltradas.length)} resultados</span>
            </div>
          </div>
          <div className="hydro-table-wrap">
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
                {filasFiltradas.map((row: CedisRow, index) => (
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
            {!filasFiltradas.length ? (
              <div className="hydro-empty">
                <b>No encontramos CEDIS</b>
                <span>Prueba con otros filtros o elimina el texto de búsqueda.</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="hydro-table-card">
          <div className="hydro-table-title">
            <div>
              <h2>Divisiones</h2>
              <span>{number.format(divisiones.length)} resultados</span>
            </div>
          </div>
          <div className="hydro-table-wrap">
            {divisionColumns.length ? (
              <table>
                <thead>
                  <tr>
                    {divisionColumns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {divisiones.map((row, index) => (
                    <tr key={index}>
                      {divisionColumns.map((col) => (
                        <td key={col}>{row[col] === null || row[col] === undefined ? "—" : String(row[col])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hydro-empty">
                <b>Sin datos de división</b>
                <span>El catálogo no devolvió filas.</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
