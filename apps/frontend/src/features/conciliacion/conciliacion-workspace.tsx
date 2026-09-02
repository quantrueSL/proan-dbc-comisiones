"use client";

// Módulo 3 · Conciliación por comisionista — conectada de verdad a
// POST /api/comisionesbi/reconciliation.
//
// EL PLAN VIEJO (bajar de un pago agregado en BSIK a factura/material, con
// "confianza" de match) se abandonó el 2026-09-02: no existe esa fuente en
// BigQuery (Datos/Comisiones_DBC_Borrador_Tecnico.md, sección 16.3). Esto hace
// otra cosa, alcanzable: reproduce automáticamente la hoja que hoy arma a mano
// quien concilia (periodo de pago → comisionista → producto, con cantidad,
// tarifa y comisión), para que solo tenga que compararla contra lo que le
// pagaron, no reconstruirla. El "periodo" normalmente es sábado-viernes, pero
// se corta antes si cruza de mes (supuesto pendiente de confirmar con el
// cliente, ver conciliacion_engine.py) -- por eso el Excel también trae el
// detalle día por día, para poder verificarlo o ajustarlo a mano.
//
// MAESTRO-DETALLE: la tabla de arriba es a quién hay que pagarle (nivel 1). Un
// clic abre el panel con el detalle por producto de ESE comisionista+división
// (nivel 2), que es lo que se descarga. No hay match automático contra lo
// pagado -- eso sigue sin fuente, así que no se finge que existe.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FiltersSidebar } from "@/components/filters-sidebar";
import type {
  ConciliacionDetalleRow,
  ConciliacionDiarioRow,
  ConciliacionFilters,
  ConciliacionPorComisionista,
  ConciliacionResponse
} from "@/types/comisiones";

type Filtros = { division: string; comisionista: string; desde: string; hasta: string };
type Seleccion = { comisionista: string | null; division_code: string | null };

type Props = {
  initialError: string | null;
  initialResponse: ConciliacionResponse | null;
  rangoInicial: { desde: string; hasta: string };
};

const dinero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const numero = new Intl.NumberFormat("es-MX");
const cantidad = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const fechaLarga = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric" });

function pesos(valor: number) {
  return `$${dinero.format(valor)}`;
}

// Igual que en comisiones-workspace: por partes, para no perder un día al
// interpretar la fecha como UTC.
function enPalabras(iso: string | undefined | null) {
  if (!iso) return null;
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) return null;
  return fechaLarga.format(new Date(a, m - 1, d));
}

const fechaCorta = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" });

/** "2026-08-05" -> "5 ago", para la columna Semana de la tabla de detalle: el
 *  formato largo ("5 de agosto de 2026") no cabe en una columna angosta y el
 *  año ya está en el periodo de la cabecera del panel. */
function semanaCorta(iso: string) {
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) return iso;
  return fechaCorta.format(new Date(a, m - 1, d));
}

function nombreComisionista(valor: string | null) {
  return valor ?? "Sin comisionista asignado";
}

function compararConNulosAlFinal(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

// Mayor cantidad primero: dentro de la misma semana/CEDIS/oficina, el producto
// que más se vendió es el que más rápido se quiere ver.
function compararCantidadDescNulosAlFinal(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const AZUL_MARCA = "FF3D3D7C"; // mismo azul que el resto de la pantalla de comisiones
const GRIS_ZEBRA = "FFF3F4F6";
const BLANCO = "FFFFFFFF";

type ColumnaExcel = { encabezado: string; ancho: number; alinear?: "left" | "right"; formato?: string };

/** Mismas columnas en las dos hojas del libro -- solo cambia el rótulo de la
 *  primera (Periodo/Fecha), por eso es una función y no una constante. */
function columnasExcel(etiquetaPrimeraColumna: string): ColumnaExcel[] {
  return [
    { encabezado: etiquetaPrimeraColumna, ancho: 13 },
    { encabezado: "CEDIS", ancho: 16 },
    { encabezado: "Oficina", ancho: 10 },
    { encabezado: "Tipo de venta", ancho: 16 },
    { encabezado: "Material", ancho: 13 },
    { encabezado: "Descripción", ancho: 32 },
    { encabezado: "Cantidad vendida", ancho: 16, alinear: "right", formato: "#,##0.00" },
    { encabezado: "Unidad vendida", ancho: 12 },
    { encabezado: "Cantidad base", ancho: 15, alinear: "right", formato: "#,##0.00" },
    { encabezado: "Unidad base", ancho: 11 },
    { encabezado: "Tarifa", ancho: 11, alinear: "right", formato: '"$"#,##0.00' },
    { encabezado: "Comisión", ancho: 13, alinear: "right", formato: '"$"#,##0.00' },
    { encabezado: "Importe facturado", ancho: 17, alinear: "right", formato: '"$"#,##0.00' }
  ];
}

type FilaComun = {
  cedis: string | null;
  oficina: string | null;
  tipo_venta: string | null;
  matnr: string;
  descripcion: string | null;
  cantidad_venta_total: number | null;
  unidad_venta: string | null;
  cantidad_base_total: number | null;
  base_unidad: string | null;
  tarifa: number | null;
  comision_total: number;
  monto_total: number;
};

/** Una hoja del libro: encabezado con color de marca, título con comisionista
 *  /división/periodo, bandas de color cada dos filas y fila de total -- para
 *  que se pueda entregar tal cual a Hacienda, no un volcado plano de datos.
 *  `etiquetaPeriodo(fila)` saca el valor de la primera columna (el periodo
 *  agregado en la hoja de conciliación, la fecha exacta en la de detalle
 *  diario): es lo único que distingue a las dos hojas del libro. */
function agregarHoja<T extends FilaComun>(
  libro: import("exceljs").Workbook,
  opciones: {
    nombreHoja: string;
    tituloPrincipal: string;
    subtitulo: string;
    etiquetaPrimeraColumna: string;
    etiquetaPeriodo: (fila: T) => string;
    filas: T[];
  }
) {
  const columnas = columnasExcel(opciones.etiquetaPrimeraColumna);
  const hoja = libro.addWorksheet(opciones.nombreHoja, { views: [{ state: "frozen", ySplit: 4 }] });
  hoja.columns = columnas.map((c) => ({ width: c.ancho }));

  const FILA_TITULO = 1;
  const FILA_SUBTITULO = 2;
  const FILA_ENCABEZADO = 4;
  const numColumnas = columnas.length;

  hoja.mergeCells(FILA_TITULO, 1, FILA_TITULO, numColumnas);
  const titulo = hoja.getCell(FILA_TITULO, 1);
  titulo.value = opciones.tituloPrincipal;
  titulo.font = { bold: true, size: 14 };
  hoja.getRow(FILA_TITULO).height = 24;

  hoja.mergeCells(FILA_SUBTITULO, 1, FILA_SUBTITULO, numColumnas);
  const subtitulo = hoja.getCell(FILA_SUBTITULO, 1);
  subtitulo.value = opciones.subtitulo;
  subtitulo.font = { italic: true, size: 10, color: { argb: "FF6B7280" } };

  const filaEncabezado = hoja.getRow(FILA_ENCABEZADO);
  columnas.forEach((columna, indice) => {
    const celda = filaEncabezado.getCell(indice + 1);
    celda.value = columna.encabezado;
    celda.font = { bold: true, color: { argb: BLANCO } };
    celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_MARCA } };
    celda.alignment = { vertical: "middle", horizontal: columna.alinear ?? "left" };
  });
  filaEncabezado.height = 20;
  hoja.autoFilter = { from: { row: FILA_ENCABEZADO, column: 1 }, to: { row: FILA_ENCABEZADO, column: numColumnas } };

  opciones.filas.forEach((f, indice) => {
    const valores = [
      opciones.etiquetaPeriodo(f),
      f.cedis ?? "",
      f.oficina ?? "",
      f.tipo_venta ?? "",
      f.matnr,
      f.descripcion ?? "",
      f.cantidad_venta_total,
      f.unidad_venta ?? "",
      f.cantidad_base_total,
      f.base_unidad ?? "",
      f.tarifa,
      f.comision_total,
      f.monto_total
    ];
    const fila = hoja.getRow(FILA_ENCABEZADO + 1 + indice);
    valores.forEach((valor, columnaIndice) => {
      const columna = columnas[columnaIndice];
      const celda = fila.getCell(columnaIndice + 1);
      celda.value = valor;
      if (columna.formato) celda.numFmt = columna.formato;
      celda.alignment = { horizontal: columna.alinear ?? "left" };
      if (indice % 2 === 1) celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_ZEBRA } };
    });
  });

  const filaTotal = hoja.getRow(FILA_ENCABEZADO + 1 + opciones.filas.length);
  const totalComision = opciones.filas.reduce((suma, f) => suma + f.comision_total, 0);
  const totalMonto = opciones.filas.reduce((suma, f) => suma + f.monto_total, 0);
  const celdaEtiqueta = filaTotal.getCell(numColumnas - 2);
  celdaEtiqueta.value = "TOTAL";
  celdaEtiqueta.font = { bold: true };
  celdaEtiqueta.alignment = { horizontal: "right" };
  const celdaComision = filaTotal.getCell(numColumnas - 1);
  celdaComision.value = totalComision;
  celdaComision.numFmt = '"$"#,##0.00';
  celdaComision.font = { bold: true };
  const celdaMonto = filaTotal.getCell(numColumnas);
  celdaMonto.value = totalMonto;
  celdaMonto.numFmt = '"$"#,##0.00';
  celdaMonto.font = { bold: true };
  for (let c = 1; c <= numColumnas; c++) {
    filaTotal.getCell(c).border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } };
  }
}

/** El libro completo: la hoja de conciliación (por periodo de pago, lo que
 *  ella compara contra su factura) y una segunda hoja de detalle día por día
 *  -- la transparencia para el borde de mes, ver la cabecera del archivo.
 *  `exceljs` se importa dinámico: es una librería pesada que solo hace falta
 *  al pulsar el botón. */
async function construirExcel(datos: {
  comisionista: string;
  division: string;
  desde: string;
  hasta: string;
  filas: ConciliacionDetalleRow[];
  filasDiarias: ConciliacionDiarioRow[];
}): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const libro = new ExcelJS.Workbook();
  libro.creator = "Comisiones DBC";
  libro.created = new Date();

  const subtitulo = `Del ${datos.desde} al ${datos.hasta} · generado el ${new Date().toLocaleDateString("es-MX")}`;

  agregarHoja(libro, {
    nombreHoja: "Conciliación",
    tituloPrincipal: `Conciliación de comisión — ${datos.comisionista} · ${datos.division}`,
    subtitulo,
    etiquetaPrimeraColumna: "Periodo",
    etiquetaPeriodo: (f: ConciliacionDetalleRow) => f.semana,
    filas: datos.filas
  });

  agregarHoja(libro, {
    nombreHoja: "Detalle diario",
    tituloPrincipal: `Detalle diario — ${datos.comisionista} · ${datos.division}`,
    subtitulo: `${subtitulo} · el periodo de arriba se corta en fin de mes, esta hoja lo verifica día por día`,
    etiquetaPrimeraColumna: "Fecha",
    etiquetaPeriodo: (f: ConciliacionDiarioRow) => f.fecha,
    filas: datos.filasDiarias
  });

  const buffer = await libro.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function descargarBlob(nombreArchivo: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

export function ConciliacionWorkspace({ initialError, initialResponse, rangoInicial }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [division, setDivision] = useState("");
  const [comisionista, setComisionista] = useState("");
  const [desde, setDesde] = useState(rangoInicial.desde);
  const [hasta, setHasta] = useState(rangoInicial.hasta);
  const [response, setResponse] = useState(initialResponse);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);
  // El panel se porta a document.body (ver más abajo): en el layout autenticado
  // algún ancestro trae `backdrop-filter`/`transform`, que en CSS crea un nuevo
  // "containing block" para `position: fixed` -- el panel quedaba atrapado
  // dentro de esa caja en vez de anclarse al viewport real, y se veía angosto y
  // centrado en vez de pegado al borde. `document.body` no existe en el
  // render del servidor, así que el portal solo se activa tras montar.
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  async function load(cambios: Partial<Filtros> = {}) {
    const f: Filtros = { division, comisionista, desde, hasta, ...cambios };
    setLoading(true);
    setError(null);
    try {
      const body: ConciliacionFilters = {
        division: f.division || null,
        comisionista: f.comisionista || null,
        start_date: f.desde,
        end_date: f.hasta
      };
      const res = await fetch("/api/comisionesbi/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await res.json().catch(() => null)) as (ConciliacionResponse & { detail?: string }) | null;
      if (!res.ok) {
        throw new Error(payload?.detail || "No se pudo generar la conciliación.");
      }
      setResponse(payload);
      setSeleccion(null); // el filtro cambió: la selección anterior puede ya no existir
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar la conciliación.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!seleccion) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSeleccion(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [seleccion]);

  const activeFilterCount = [division, comisionista].filter(Boolean).length;
  const filasComisionista = response?.por_comisionista ?? [];

  const nombresComisionista = useMemo(
    () => Array.from(new Set(filasComisionista.map((f) => f.comisionista).filter((n): n is string => Boolean(n)))).sort(),
    [filasComisionista]
  );

  const detalleSeleccion = useMemo(() => {
    if (!seleccion || !response) return [];
    return response.detalle
      .filter((d) => d.comisionista === seleccion.comisionista && d.division_code === seleccion.division_code)
      .slice()
      .sort((a, b) => {
        // Semana más antigua primero: es el orden en que ella revisa las
        // facturas, no el que más pesa. Cedis/oficina como desempate, nulos
        // al final (igual que en el resto de la pantalla). `semana` es ISO
        // (YYYY-MM-DD), así que comparar como texto ya da orden cronológico.
        if (a.semana !== b.semana) return a.semana < b.semana ? -1 : 1;
        return (
          compararConNulosAlFinal(a.cedis, b.cedis) ||
          compararConNulosAlFinal(a.oficina, b.oficina) ||
          compararCantidadDescNulosAlFinal(a.cantidad_venta_total, b.cantidad_venta_total)
        );
      });
  }, [seleccion, response]);

  const comisionSeleccion = detalleSeleccion.reduce((suma, d) => suma + d.comision_total, 0);
  const montoSeleccion = detalleSeleccion.reduce((suma, d) => suma + d.monto_total, 0);

  async function exportarSeleccion() {
    if (!seleccion) return;
    const nombreArchivo = nombreComisionista(seleccion.comisionista).replace(/\s+/g, "_");
    const div = seleccion.division_code ?? "sd";
    setExportando(true);
    try {
      // El detalle diario se pide aparte, solo al exportar: es la misma
      // combinación comisionista+división+periodo, sin agregar por periodo de
      // pago -- la segunda hoja del Excel (ver construirExcel).
      const respuestaDiaria = await fetch("/api/comisionesbi/reconciliation/diario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          division: seleccion.division_code,
          comisionista: seleccion.comisionista,
          start_date: desde,
          end_date: hasta
        } satisfies ConciliacionFilters)
      });
      const payloadDiario = (await respuestaDiaria.json().catch(() => null)) as
        | ConciliacionDiarioRow[]
        | { detail?: string }
        | null;
      if (!respuestaDiaria.ok) {
        const detalle = payloadDiario && !Array.isArray(payloadDiario) ? payloadDiario.detail : undefined;
        throw new Error(detalle || "No se pudo generar el detalle diario.");
      }
      const filasDiarias = (Array.isArray(payloadDiario) ? payloadDiario : [])
        .slice()
        .sort((a, b) => {
          if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
          return compararConNulosAlFinal(a.cedis, b.cedis) || compararConNulosAlFinal(a.oficina, b.oficina);
        });

      const blob = await construirExcel({
        comisionista: nombreComisionista(seleccion.comisionista),
        division: filasComisionista.find(
          (f) => f.comisionista === seleccion.comisionista && f.division_code === seleccion.division_code
        )?.division ?? seleccion.division_code ?? "",
        desde,
        hasta,
        filas: detalleSeleccion,
        filasDiarias
      });
      descargarBlob(`conciliacion_${nombreArchivo}_${div}_${desde}_${hasta}.xlsx`, blob);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el Excel.");
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="workspace-with-sidebar">
      <FiltersSidebar
        activeCount={activeFilterCount}
        info={
          <>
            <p>
              El detalle por producto que hoy se arma a mano cada semana, listo para comparar contra
              lo que se le pagó a cada comisionista.
            </p>
            <h3>Lo que esta pantalla NO hace</h3>
            <p>
              No cruza contra el pago real del comisionista: no existe una fuente en BigQuery que
              baje de la liquidación agregada al detalle de factura (se probaron seis vías distintas,
              ninguna llega — ver la sección 16.3 del borrador técnico). El paso de comparar el total
              contra lo pagado se sigue haciendo a mano.
            </p>
            <h3>Un supuesto pendiente de confirmar</h3>
            <p>
              En Botana, Leche y Abarrotes, la cantidad base (la que multiplica la tarifa) se asume en
              <b> cajas</b>. Es un supuesto de trabajo, no una confirmación del cliente como en Huevo e
              Ingrediente Animal (kg).
            </p>
          </>
        }
        infoTitle="Conciliación"
        onToggle={() => setFiltersOpen((v) => !v)}
        open={filtersOpen}
        updatedAt={response?.cobertura?.hasta ?? null}
      >
        <label>
          División
          <select onChange={(e) => setDivision(e.target.value)} value={division}>
            <option value="">Todas</option>
            <option value="H">Huevo</option>
            <option value="BO">Botana</option>
            <option value="IA">Alimento (croqueta)</option>
            <option value="A">Abarrotes</option>
            <option value="L">Leche</option>
          </select>
        </label>
        <label>
          Comisionista
          <select onChange={(e) => setComisionista(e.target.value)} value={comisionista}>
            <option value="">Todos</option>
            {nombresComisionista.map((n) => (
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
          <button className="hydro-button" disabled={loading} onClick={() => void load()} type="button">
            {loading ? "Calculando…" : "Calcular"}
          </button>
          <button
            className="hydro-link-button"
            onClick={() => {
              setDivision("");
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

      <div className="hydro-page conciliacion-pagina" data-module="conciliacion">
        {error ? <p className="hydro-error">{error}</p> : null}

        <header className="operational-summary">
          <div className="operational-summary-title">
            <p>Conciliación</p>
            <h1>Comisión por comisionista</h1>
            <span>
              Semana sábado a viernes, detalle por producto - Se hace el ajuste a final de mes.
            </span>
            <div className="periodo-activo">
              <span>
                Del <b>{enPalabras(desde) ?? desde}</b> al <b>{enPalabras(hasta) ?? hasta}</b>
              </span>
            </div>
          </div>
        </header>

        <section className="hydro-table-card">
          <div className="hydro-table-title">
            <div>
              <h2>Comisionistas</h2>
              <span>{numero.format(filasComisionista.length)} comisionista(s) · división · clic en una fila para ver el detalle</span>
            </div>
          </div>
          {filasComisionista.length ? (
            <div className="hydro-table-wrap">
              <table className="conciliacion-tabla-fija">
                {/* Ancho explícito por columna: sin esto el nombre del
                    comisionista (puede traer el apodo entre paréntesis) se
                    desborda sobre División, que es la que menos espacio
                    necesita (HUEVO, BOTANA... siempre corto). */}
                <colgroup>
                  <col style={{ width: "36%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "10%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Comisionista</th>
                    <th>División</th>
                    <th className="n">Líneas</th>
                    <th className="n">Facturado</th>
                    <th className="n">Comisión</th>
                    <th className="n">Semanas</th>
                  </tr>
                </thead>
                <tbody>
                  {filasComisionista.map((fila, indice) => (
                    <tr
                      key={indice}
                      onClick={() => setSeleccion({ comisionista: fila.comisionista, division_code: fila.division_code })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSeleccion({ comisionista: fila.comisionista, division_code: fila.division_code });
                        }
                      }}
                      tabIndex={0}
                    >
                      <td title={nombreComisionista(fila.comisionista)}>{nombreComisionista(fila.comisionista)}</td>
                      <td>{fila.division ?? fila.division_code ?? "—"}</td>
                      <td className="n">{numero.format(fila.num_lineas)}</td>
                      <td className="n">{pesos(fila.monto_total)}</td>
                      <td className="n">{pesos(fila.comision_total)}</td>
                      <td className="n">{fila.num_semanas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hydro-muted">Sin comisión calculada en el periodo.</p>
          )}
        </section>
      </div>

      {seleccion && montado
        ? createPortal(
            <>
              <button aria-label="Cerrar detalle" className="hydro-detail-backdrop" onClick={() => setSeleccion(null)} type="button" />
          <div className="hydro-detail hydro-detail--conciliacion">
            <div className="hydro-detail-header">
              <div>
                <p>Detalle por producto</p>
                <h2>{nombreComisionista(seleccion.comisionista)}</h2>
              </div>
              <button aria-label="Cerrar" onClick={() => setSeleccion(null)} type="button">
                ×
              </button>
            </div>
            <div className="hydro-detail-body">
              <p className="hydro-nota">
                {filasComisionista.find(
                  (f) => f.comisionista === seleccion.comisionista && f.division_code === seleccion.division_code
                )?.division ?? seleccion.division_code}{" "}
                · del {enPalabras(desde) ?? desde} al {enPalabras(hasta) ?? hasta} · {pesos(montoSeleccion)} facturado
                · {pesos(comisionSeleccion)} de comisión
              </p>
              <div className="filters-sidebar-actions">
                <button
                  className="hydro-button"
                  disabled={!detalleSeleccion.length || exportando}
                  onClick={() => void exportarSeleccion()}
                  type="button"
                >
                  {exportando ? "Generando…" : "Descargar Excel"}
                </button>
              </div>
              {detalleSeleccion.length ? (
                <div className="hydro-table-wrap">
                  <table className="conciliacion-tabla-fija">
                    {/* Ancho fijo por columna a propósito: con auto, "5 de
                        agosto de 2026" y una descripción larga de producto se
                        desbordaban una encima de otra y no se leía nada. */}
                    <colgroup>
                      <col style={{ width: "9%" }} />
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "13%" }} />
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "10%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Semana</th>
                        <th>CEDIS</th>
                        <th>Oficina</th>
                        <th>Tipo de venta</th>
                        <th>Producto</th>
                        <th className="n">Vendido</th>
                        <th className="n">Base</th>
                        <th className="n">Tarifa</th>
                        <th className="n">Comisión</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalleSeleccion.map((d, indice) => (
                        <tr key={indice}>
                          <td title={enPalabras(d.semana) ?? d.semana}>{semanaCorta(d.semana)}</td>
                          <td title={d.cedis ?? ""}>{d.cedis ?? "—"}</td>
                          <td>{d.oficina ?? "—"}</td>
                          <td title={d.tipo_venta ?? ""}>{d.tipo_venta ?? "—"}</td>
                          <td className="conciliacion-col-ancha" title={d.descripcion ?? d.matnr}>
                            {d.descripcion ?? d.matnr}
                          </td>
                          <td className="n">
                            {d.cantidad_venta_total !== null ? cantidad.format(d.cantidad_venta_total) : "—"}{" "}
                            <small>{d.unidad_venta}</small>
                          </td>
                          <td className="n">
                            {d.cantidad_base_total !== null ? cantidad.format(d.cantidad_base_total) : "—"}{" "}
                            <small>{d.base_unidad}</small>
                          </td>
                          <td className="n">{d.tarifa !== null ? cantidad.format(d.tarifa) : "—"}</td>
                          <td className="n">{pesos(d.comision_total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={8}>Total</td>
                        <td className="n">{pesos(comisionSeleccion)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="hydro-muted">Sin líneas para esta combinación en el periodo.</p>
              )}
            </div>
          </div>
            </>,
            document.body
          )
        : null}
    </div>
  );
}
