import type { CortesExportPagoResponse, CortesPago } from "@/types/comisiones";
import { ETIQUETA_ESTADO } from "./cortes-logica";

// El Excel de un pago: copia del de la pestaña de Conciliación (mismas hojas, columnas y totales), acotado a la ventana del pago.

const AZUL_MARCA = "FF3D3D7C";
const GRIS_ZEBRA = "FFF3F4F6";
const GRIS_TOTAL = "FFE5E7EB";
const BLANCO = "FFFFFFFF";
const MONEDA = '"$"#,##0.00';
const NUMERO2 = "#,##0.00";

type ColumnaExcel = {
  encabezado: string;
  ancho: number;
  alinear?: "left" | "right";
  formato?: string;
  /** Lleva fórmula SUBTOTAL en la fila de total (una tarifa no se suma). */
  sumable?: boolean;
};

type Valor = string | number | boolean | null;

function columnaLetra(indice: number): string {
  let n = indice;
  let letra = "";
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

const COLUMNAS_PRODUCTO: ColumnaExcel[] = [
  { encabezado: "CEDIS", ancho: 16 },
  { encabezado: "Oficina", ancho: 10 },
  { encabezado: "Tipo de venta", ancho: 16 },
  { encabezado: "Material", ancho: 13 },
  { encabezado: "Descripción", ancho: 32 },
  { encabezado: "Cantidad vendida", ancho: 16, alinear: "right", formato: NUMERO2, sumable: true },
  { encabezado: "Unidad vendida", ancho: 12 },
  { encabezado: "Cantidad base", ancho: 15, alinear: "right", formato: NUMERO2, sumable: true },
  { encabezado: "Unidad tarifa", ancho: 12 },
  { encabezado: "Tarifa", ancho: 11, alinear: "right", formato: MONEDA },
  { encabezado: "Comisión", ancho: 13, alinear: "right", formato: MONEDA, sumable: true },
  { encabezado: "Importe facturado", ancho: 17, alinear: "right", formato: MONEDA, sumable: true }
];

type FilaProducto = {
  cedis: string | null;
  oficina: string | null;
  tipo_venta: string | null;
  matnr: string;
  descripcion: string | null;
  cantidad_venta_total: number | null;
  unidad_venta: string | null;
  cantidad_base_total: number | null;
  unidad_tarifa: string | null;
  tarifa: number | null;
  comision_total: number;
  monto_total: number;
};

const valoresProducto = (f: FilaProducto): Valor[] => [
  f.cedis ?? "",
  f.oficina ?? "",
  f.tipo_venta ?? "",
  f.matnr,
  f.descripcion ?? "",
  f.cantidad_venta_total,
  f.unidad_venta ?? "",
  f.cantidad_base_total,
  f.unidad_tarifa ?? "",
  f.tarifa,
  f.comision_total,
  f.monto_total
];

/** Una hoja: título, subtítulo, encabezado de color, total con SUBTOTAL (cambia si se filtra) pegado al encabezado y bandas. */
function agregarHoja<T>(
  libro: import("exceljs").Workbook,
  opciones: { nombreHoja: string; titulo: string; subtitulo: string; columnas: ColumnaExcel[]; valores: (fila: T) => Valor[]; filas: T[] }
) {
  const { columnas, filas } = opciones;
  const hoja = libro.addWorksheet(opciones.nombreHoja, { views: [{ state: "frozen", ySplit: 5 }] });
  hoja.columns = columnas.map((c) => ({ width: c.ancho }));
  const FILA_ENCABEZADO = 4;
  const FILA_TOTAL = 5;
  const FILA_DATOS = 6;
  const n = columnas.length;

  hoja.mergeCells(1, 1, 1, n);
  const titulo = hoja.getCell(1, 1);
  titulo.value = opciones.titulo;
  titulo.font = { bold: true, size: 14 };
  hoja.getRow(1).height = 24;
  hoja.mergeCells(2, 1, 2, n);
  const subtitulo = hoja.getCell(2, 1);
  subtitulo.value = opciones.subtitulo;
  subtitulo.font = { italic: true, size: 10, color: { argb: "FF6B7280" } };

  const encabezado = hoja.getRow(FILA_ENCABEZADO);
  columnas.forEach((c, i) => {
    const celda = encabezado.getCell(i + 1);
    celda.value = c.encabezado;
    celda.font = { bold: true, color: { argb: BLANCO } };
    celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_MARCA } };
    celda.alignment = { vertical: "middle", horizontal: c.alinear ?? "left" };
  });
  encabezado.height = 20;
  hoja.autoFilter = { from: { row: FILA_ENCABEZADO, column: 1 }, to: { row: FILA_ENCABEZADO, column: n } };

  const total = hoja.getRow(FILA_TOTAL);
  columnas.forEach((c, i) => {
    const celda = total.getCell(i + 1);
    if (c.sumable && filas.length) {
      const col = columnaLetra(i + 1);
      celda.value = { formula: `SUBTOTAL(109,${col}${FILA_DATOS}:${col}${FILA_DATOS + filas.length - 1})` };
      if (c.formato) celda.numFmt = c.formato;
    } else if (i === 0) {
      celda.value = "TOTAL";
    }
    celda.font = { bold: true };
    celda.alignment = { horizontal: c.alinear ?? "left" };
    celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_TOTAL } };
    celda.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } }, bottom: { style: "thin", color: { argb: "FF9CA3AF" } } };
  });
  total.height = 20;

  filas.forEach((f, indice) => {
    const fila = hoja.getRow(FILA_DATOS + indice);
    opciones.valores(f).forEach((valor, i) => {
      const c = columnas[i];
      const celda = fila.getCell(i + 1);
      celda.value = valor;
      if (c.formato) celda.numFmt = c.formato;
      celda.alignment = { horizontal: c.alinear ?? "left" };
      if (indice % 2 === 1) celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_ZEBRA } };
    });
  });
}

/** Un cambio hecho a mano sobre el pago (de su historial), ya en palabras. */
export type Modificacion = { cuando: string; quien: string; que: string };

export type ContextoExcelPago = {
  comisionista: string;
  /** "Huevo" o "Huevo + Abarrotes". */
  division: string;
  pago: CortesPago;
  modificaciones: Modificacion[];
};

// Colores por estado, los mismos de la pantalla: [relleno, letra].
const COLOR_ESTADO: Record<CortesPago["estado"], [string, string]> = {
  ok: ["FFDCFCE7", "FF166534"],
  sug: ["FFE0E7FF", "FF3D3D7C"],
  sin: ["FFFEE2E2", "FF991B1B"],
  sinv: ["FFFEF3C7", "FF92400E"],
  cons: ["FFE5E7EB", "FF374151"]
};
const TEXTO_ESTADO: Record<CortesPago["estado"], string> = {
  ok: "La comisión calculada cuadra con lo pagado (±$1).",
  sug: "Hay una sugerencia que deja este pago exacto; falta aplicarla o descartarla.",
  sin: "Ningún ajuste de hasta 3 días en los cortes cuadra este pago.",
  sinv: "El pago no tiene una ventana legible en su texto.",
  cons: "Pago consolidado: su ventana, lo pagado y lo calculado quedaron congelados."
};
const VERDE: [string, string] = ["FFDCFCE7", "FF166534"];
const ROJO: [string, string] = ["FFFEE2E2", "FF991B1B"];
const NEUTRO: [string, string] = ["FFF3F4F6", "FF111827"];

/** Hoja de entrada: pagado, calculado y diferencia en grande y con color, el estado y todo lo que se tocó a mano. */
function agregarResumen(libro: import("exceljs").Workbook, datos: CortesExportPagoResponse, ctx: ContextoExcelPago, quien: string, subtitulo: string) {
  const p = ctx.pago;
  const hoja = libro.addWorksheet("Resumen", { views: [{ showGridLines: false }] });
  hoja.columns = [{ width: 24 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }];
  const relleno = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
  const fijar = (fila: number, c1: number, c2: number, valor: Valor, opciones: { fondo?: string; letra?: string; tam?: number; negrita?: boolean; formato?: string; alinear?: "left" | "center" | "right" } = {}) => {
    if (c2 > c1) hoja.mergeCells(fila, c1, fila, c2);
    const celda = hoja.getCell(fila, c1);
    celda.value = valor;
    celda.font = { bold: opciones.negrita ?? false, size: opciones.tam ?? 11, color: { argb: opciones.letra ?? "FF111827" } };
    celda.alignment = { vertical: "middle", horizontal: opciones.alinear ?? "left", wrapText: true };
    if (opciones.formato) celda.numFmt = opciones.formato;
    for (let c = c1; c <= c2; c++) {
      const x = hoja.getCell(fila, c);
      if (opciones.fondo) x.fill = relleno(opciones.fondo);
    }
  };

  fijar(1, 1, 6, `Resumen del pago — ${quien}`, { tam: 16, negrita: true });
  hoja.getRow(1).height = 28;
  fijar(2, 1, 6, subtitulo, { tam: 10, letra: "FF6B7280" });

  // Tres tarjetas: pagado, calculado y diferencia (verde si cuadra, roja si no).
  const diferencia = p.diferencia ?? (p.calculado === null ? null : p.calculado - p.pagado);
  const colorDif = diferencia !== null && Math.abs(diferencia) <= 1 ? VERDE : diferencia === null ? NEUTRO : ROJO;
  const tarjetas: { col: number; titulo: string; valor: number | null; color: [string, string]; nota: string }[] = [
    { col: 1, titulo: "PAGADO", valor: p.pagado, color: NEUTRO, nota: "Lo que se pagó en SAP" },
    { col: 3, titulo: "CALCULADO", valor: p.calculado, color: NEUTRO, nota: datos.dias.length ? `Incluye ${datos.dias.length} día(s) de cierre asignado(s)` : "Comisión de la ventana del pago" },
    {
      col: 5,
      titulo: "DIFERENCIA",
      valor: diferencia,
      color: colorDif,
      nota: diferencia === null ? "Sin cálculo" : Math.abs(diferencia) <= 1 ? "Cuadra" : diferencia > 0 ? "Se calculó más de lo pagado" : "Se calculó menos de lo pagado"
    }
  ];
  for (const t of tarjetas) {
    fijar(4, t.col, t.col + 1, t.titulo, { fondo: t.color[0], letra: t.color[1], tam: 10, negrita: true, alinear: "center" });
    fijar(5, t.col, t.col + 1, t.valor, { fondo: t.color[0], letra: t.color[1], tam: 22, negrita: true, formato: MONEDA, alinear: "center" });
    fijar(6, t.col, t.col + 1, t.nota, { fondo: t.color[0], letra: t.color[1], tam: 9, alinear: "center" });
  }
  hoja.getRow(5).height = 38;

  // Estado.
  const [fondo, letra] = COLOR_ESTADO[p.estado];
  fijar(8, 1, 1, "ESTADO", { tam: 10, negrita: true, letra: "FF6B7280" });
  fijar(8, 2, 3, ETIQUETA_ESTADO[p.estado], { fondo, letra, tam: 14, negrita: true, alinear: "center" });
  fijar(8, 4, 6, TEXTO_ESTADO[p.estado], { tam: 10, letra: "FF374151" });
  hoja.getRow(8).height = 30;

  let fila = 10;
  const seccion = (titulo: string) => {
    fijar(fila, 1, 6, titulo, { fondo: AZUL_MARCA, letra: BLANCO, negrita: true });
    hoja.getRow(fila).height = 20;
    fila += 1;
  };
  const dato = (nombre: string, valor: Valor, fondoValor?: string) => {
    fijar(fila, 1, 1, nombre, { negrita: true, fondo: GRIS_ZEBRA });
    fijar(fila, 2, 6, valor, { fondo: fondoValor });
    fila += 1;
  };

  seccion("Datos del pago");
  const docs = p.documentos ?? [];
  dato("Pago asignado (documento SAP)", docs.map((d) => d.documento).join(", "));
  dato("Compensación (pago SAP)", docs.map((d) => d.compensacion ?? "").filter(Boolean).join(", "));
  dato("Texto del pago", docs.map((d) => d.texto ?? "").filter(Boolean).join(" / "));
  dato("Fecha de pago", docs.map((d) => d.fecha_pago ?? "").filter(Boolean).join(", "));
  dato("Ventana del pago", `${datos.ini} a ${datos.fin}`);
  fila += 1;

  // Todo lo que se tocó a mano, con color ámbar si hay algo.
  const AMBAR = "FFFEF3C7";
  seccion("Modificaciones a mano");
  const ventanaMovida = p.ini_default !== p.ini || p.fin_default !== p.fin;
  dato(
    "Ventana",
    ventanaMovida && p.ini_default && p.fin_default
      ? `Movida a mano: la estándar era ${p.ini_default} a ${p.fin_default} y ahora es ${datos.ini} a ${datos.fin}`
      : ventanaMovida
        ? `Fijada a mano: ${datos.ini} a ${datos.fin}`
        : "Sin cambios: es la ventana estándar del texto del pago",
    ventanaMovida ? AMBAR : undefined
  );
  const cierre = new Map<string, number>();
  for (const d of datos.diario) if (d.asignacion === "Cierre de mes asignado") cierre.set(d.fecha, (cierre.get(d.fecha) ?? 0) + d.comision_total);
  dato(
    "Días de cierre de mes",
    datos.dias.length
      ? datos.dias.map((d) => `${d} (${textoImporte(cierre.get(d) ?? 0)})`).join(", ") + " incluidos en este pago"
      : "Ninguno asignado",
    datos.dias.length ? AMBAR : undefined
  );
  dato(
    "Consolidación",
    p.estado === "cons" ? `Consolidado${p.consolidado_por ? ` por ${p.consolidado_por}` : ""}${p.consolidado_en ? ` el ${p.consolidado_en.slice(0, 10)}` : ""}` : "No está consolidado"
  );
  dato("Sugerencia", p.descartada ? "Se descartó la sugerencia de este pago" : p.estado === "sug" ? "Pendiente de revisar" : "—");
  fila += 1;

  if (ctx.modificaciones.length) {
    fijar(fila, 1, 1, "Cuándo", { negrita: true, fondo: GRIS_TOTAL });
    fijar(fila, 2, 2, "Quién", { negrita: true, fondo: GRIS_TOTAL });
    fijar(fila, 3, 6, "Qué hizo", { negrita: true, fondo: GRIS_TOTAL });
    fila += 1;
    for (const m of ctx.modificaciones) {
      fijar(fila, 1, 1, m.cuando);
      fijar(fila, 2, 2, m.quien);
      fijar(fila, 3, 6, m.que);
      fila += 1;
    }
  } else {
    fijar(fila, 1, 6, "Sin cambios registrados en el historial de este pago.", { tam: 10, letra: "FF6B7280" });
  }
}

function textoImporte(valor: number): string {
  return `$${valor.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Un renglón por periodo de pago, como en la pestaña de Conciliación. */
const COLUMNAS_RESUMEN_PERIODO: ColumnaExcel[] = [
  { encabezado: "Periodo", ancho: 24 },
  { encabezado: "Calculado", ancho: 15, alinear: "right", formato: MONEDA, sumable: true },
  { encabezado: "Pagado", ancho: 15, alinear: "right", formato: MONEDA, sumable: true },
  { encabezado: "Diferencia", ancho: 15, alinear: "right", formato: MONEDA, sumable: true }
];

/**
 * El libro de un pago, el mismo que baja la pestaña de Conciliación (hojas, columnas y totales) pero acotado a la ventana del pago
 * y a los días de cierre que se le hayan asignado a mano; un día que se quitó de la ventana no baja. `exceljs` se importa al pulsar
 * el botón: pesa.
 */
export async function construirExcelPago(datos: CortesExportPagoResponse, ctx: ContextoExcelPago): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const libro = new ExcelJS.Workbook();
  libro.creator = "Comisiones DBC";
  libro.created = new Date();

  const quien = `${ctx.comisionista} · ${ctx.division}`;
  const documento = (ctx.pago.documentos ?? []).map((d) => d.documento).join(", ");
  const subtitulo = `Del ${datos.ini} al ${datos.fin}${documento ? ` · pago ${documento}` : ""} · generado el ${new Date().toLocaleDateString("es-MX")}`;

  agregarResumen(libro, datos, ctx, quien, subtitulo);

  agregarHoja(libro, {
    nombreHoja: "Conciliación",
    titulo: `Conciliación de comisión — ${quien}`,
    subtitulo,
    columnas: [{ encabezado: "Periodo", ancho: 24 }, ...COLUMNAS_PRODUCTO],
    valores: (f: CortesExportPagoResponse["productos"][number]) => [`${f.semana} - ${f.periodo_fin}`, ...valoresProducto(f)],
    filas: datos.productos
  });

  const p = ctx.pago;
  agregarHoja(libro, {
    nombreHoja: "Pagado vs. calculado",
    titulo: `Pagado vs. calculado por periodo — ${quien}`,
    subtitulo: `${subtitulo} · un renglón por periodo de pago, mismo comparativo que el panel de la pantalla`,
    columnas: COLUMNAS_RESUMEN_PERIODO,
    valores: (f: { periodo: string; calculado: number | null; pagado: number; diferencia: number | null }) => [f.periodo, f.calculado, f.pagado, f.diferencia],
    filas: [{ periodo: `${datos.ini} - ${datos.fin}`, calculado: p.calculado, pagado: p.pagado, diferencia: p.calculado === null ? null : p.calculado - p.pagado }]
  });

  agregarHoja(libro, {
    nombreHoja: "Detalle diario",
    titulo: `Detalle diario — ${quien}`,
    subtitulo: `${subtitulo} · esta hoja verifica el periodo día por día`,
    columnas: [{ encabezado: "Fecha", ancho: 13 }, ...COLUMNAS_PRODUCTO],
    valores: (f: CortesExportPagoResponse["diario"][number]) => [f.fecha, ...valoresProducto(f)],
    filas: datos.diario
  });

  agregarHoja(libro, {
    nombreHoja: "Detalle de factura",
    titulo: `Detalle de factura — ${quien}`,
    subtitulo: `${subtitulo} · una fila por factura real, con su estado de cobro`,
    columnas: [
      { encabezado: "Factura", ancho: 13 },
      { encabezado: "Línea", ancho: 8 },
      { encabezado: "Fecha", ancho: 13 },
      ...COLUMNAS_PRODUCTO,
      { encabezado: "Cobrada", ancho: 10 },
      { encabezado: "Importe cobrado", ancho: 16, alinear: "right", formato: MONEDA, sumable: true },
      { encabezado: "Comisión cobrada", ancho: 16, alinear: "right", formato: MONEDA, sumable: true },
      { encabezado: "Fecha de cobro", ancho: 13 }
    ],
    valores: (f: CortesExportPagoResponse["factura"][number]) => [
      f.billing_document,
      f.item_number,
      f.fecha,
      f.cedis ?? "",
      f.oficina ?? "",
      f.tipo_venta ?? "",
      f.matnr,
      f.descripcion ?? "",
      f.cantidad_venta,
      f.unidad_venta ?? "",
      f.cantidad_base,
      f.unidad_tarifa ?? "",
      f.tarifa,
      f.comision,
      f.monto,
      f.se_cobro ? "Sí" : "No",
      f.monto_cobrado,
      f.comision_cobrada,
      f.fecha_cobro ?? ""
    ],
    filas: datos.factura
  });

  const buffer = await libro.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function descargarBlob(nombreArchivo: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}
