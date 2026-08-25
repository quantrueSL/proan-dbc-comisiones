"use client";

// Módulo 1 · Comisiones — conectada de verdad a POST /api/comisionesbi/report.
//
// Estuvo devolviendo 501 con una vista previa de ejemplo al lado hasta que el
// cliente mandó los SETs y las tarifas el 24 de agosto de 2026. Ya no hay datos
// de ejemplo en este fichero: lo que se ve es lo que hay.
//
// LA DECISIÓN QUE MANDA SOBRE TODA LA PANTALLA: todavía no se puede calcular
// comisión sobre todo el facturado —hoy sale sobre un 58%—, y lo que falta no
// es poco: $174 M de botana dependen de cuál de las dos hojas de tarifas del
// cliente esté vigente, y eso mueve la comisión entre $13,7 M y $20,2 M.
// Enseñar el total sin eso al lado sería construir una cifra que nadie puede
// cuadrar. Así que el bloque
// "lo que todavía no entra" va SIEMPRE visible, con su importe y su motivo, y
// no detrás de un desplegable. La pregunta que tiene que poder contestar
// cualquiera que abra esto es "¿esto está completo?", y la respuesta está a la
// vista sin pulsar nada.

import { useState } from "react";
import Link from "next/link";
import { AvisoBoton } from "@/components/aviso";
import { FiltersSidebar } from "@/components/filters-sidebar";
import type {
  CedisRow,
  ComisionesCatalog,
  DivisionRow,
  ReportFilters,
  ReportResponse
} from "@/types/comisiones";

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

function Kpi({ etiqueta, valor, nota }: { etiqueta: string; valor: string; nota?: string }) {
  return (
    <div className="hydro-kpi">
      <span>{etiqueta}</span>
      <strong>{valor}</strong>
      {nota ? <em className="hydro-kpi-nota">{nota}</em> : null}
    </div>
  );
}

function divisionLabel(row: DivisionRow): string {
  const candidate = row.business_area_name;
  return candidate === null || candidate === undefined ? JSON.stringify(row) : String(candidate);
}

export function ComisionesWorkspace({ initialCatalog, initialError, initialReport, rangoInicial }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [division, setDivision] = useState("");
  const [cedis, setCedis] = useState("");
  const [comisionista, setComisionista] = useState("");
  const [desde, setDesde] = useState(rangoInicial.desde);
  const [hasta, setHasta] = useState(rangoInicial.hasta);
  const [report, setReport] = useState(initialReport);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const body: ReportFilters = {
        division: division || null,
        cedis: cedis || null,
        comisionista: comisionista || null,
        start_date: desde,
        end_date: hasta
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

  const activeFilterCount = [division, cedis, comisionista].filter(Boolean).length;
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
              Porque lo cobrado no trae material: <code>sap_pago</code> da una fila por factura, sin
              línea, así que no hay SET ni tarifa posible. Y esa fuente solo ve el 27% de lo
              facturado, con un ratio plano en los ocho meses de 2026 — si fuera retraso de cobro,
              enero estaría muy por encima de agosto.
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
        <div className="filters-sidebar-actions">
          <button className="hydro-button" disabled={loading} onClick={load} type="button">
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

      <div className="hydro-page" data-module="comisiones">
        {error ? <p className="hydro-error">{error}</p> : null}

        <header className="operational-summary">
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
          {totales ? (
            <section className="hydro-module-kpis" aria-label="Indicadores de comisión">
              <Kpi etiqueta="Comisión devengada" valor={pesos(totales.comision)} />
              <Kpi
                etiqueta="Con cobro registrado"
                valor={pesos(totales.comision_con_cobro)}
                nota="suelo conocido, no lo pagable"
              />
              <Kpi
                etiqueta="Facturado con tarifa"
                valor={`${decimal.format(totales.pct_calculable)}%`}
                nota={`${pesos(totales.monto_calculable)} de ${pesos(totales.monto)}`}
              />
              <Kpi etiqueta="Líneas calculadas" valor={numero.format(totales.num_lineas)} />
            </section>
          ) : null}
        </header>

        {/* Siempre visible, nunca plegado: es lo que impide leer el total como
            si estuviera completo. */}
        {bloqueado.length ? (
          <section className="hydro-table-card" data-bloque="pendiente">
            <div className="hydro-table-title">
              <div>
                <h2>Lo que todavía no entra en el cálculo</h2>
                <span>
                  {pesos(montoBloqueado)} facturados sin comisión aplicable
                  {horquilla > 0 ? ` · ${pesos(horquilla)} dependen de qué hoja de tarifas valga` : null}
                </span>
              </div>
            </div>
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
                  {bloqueado.map((b) => (
                    <tr key={b.motivo}>
                      <td>{b.motivo}</td>
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
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {report?.por_comisionista.length ? (
          <section className="hydro-table-card">
            <div className="hydro-table-title">
              <div>
                <h2>Comisión por comisionista</h2>
                <span>
                  {numero.format(report.por_comisionista.length)} comisionistas · ordenados por lo
                  que se les debe
                </span>
              </div>
            </div>
            <div className="hydro-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Comisionista</th>
                    <th className="n">Facturado</th>
                    <th className="n">Con tarifa</th>
                    <th className="n">Comisión devengada</th>
                    <th className="n">Con cobro registrado</th>
                  </tr>
                </thead>
                <tbody>
                  {report.por_comisionista.map((fila) => (
                    <tr key={fila.comisionista ?? "sin-asignar"}>
                      <td>{fila.comisionista ?? "Sin comisionista asignado"}</td>
                      <td className="n">{pesos(fila.monto)}</td>
                      <td className="n">
                        {fila.monto ? `${decimal.format((fila.monto_calculable / fila.monto) * 100)}%` : "—"}
                      </td>
                      <td className="n">{pesos(fila.comision)}</td>
                      <td className="n">{pesos(fila.comision_con_cobro)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {report?.por_division.length ? (
          <section className="hydro-table-card">
            <div className="hydro-table-title">
              <div>
                <h2>Por división</h2>
                <span>La tasa sale sobre el facturado que sí tiene tarifa, no sobre el total</span>
              </div>
            </div>
            <div className="hydro-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>División</th>
                    <th className="n">Facturado</th>
                    <th className="n">Con tarifa</th>
                    <th className="n">Comisión</th>
                    <th className="n">Tasa</th>
                  </tr>
                </thead>
                <tbody>
                  {report.por_division.map((fila) => (
                    <tr key={fila.division_code ?? "sin"}>
                      <td>{fila.division ?? fila.division_code ?? "Sin división"}</td>
                      <td className="n">{pesos(fila.monto)}</td>
                      <td className="n">
                        {fila.monto ? `${decimal.format((fila.monto_calculable / fila.monto) * 100)}%` : "—"}
                      </td>
                      <td className="n">{pesos(fila.comision)}</td>
                      <td className="n">
                        {fila.monto_calculable
                          ? `${decimal.format((fila.comision / fila.monto_calculable) * 100)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {totales?.lineas_sin_importe ? (
          <p className="hydro-nota">
            {numero.format(totales.lineas_sin_importe)} líneas del periodo tienen cantidad entregada
            e importe cero. Se comisionan porque hay producto entregado, y quedan marcadas por si el
            cliente decide que no deberían.
          </p>
        ) : null}
      </div>
    </div>
  );
}
