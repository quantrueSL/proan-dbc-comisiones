import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { CortesExportPagoResponse, CortesPago } from "@/types/comisiones";
import { construirExcelPago } from "./cortes-excel";

const PRODUCTO = {
  sociedad: "DBC",
  cedis: "Norte",
  oficina: "0023",
  tipo_venta: "VTA EN RUTA",
  matnr: "1",
  descripcion: "A",
  unidad_venta: "caja",
  unidad_tarifa: "kg",
  tarifa: 1.5,
  cantidad_venta_total: 10,
  cantidad_base_total: 300,
  monto_total: 100,
  comision_total: 450
};

const DATOS = {
  ini: "2026-07-01",
  fin: "2026-07-03",
  dias: ["2026-06-30"],
  productos: [
    { ...PRODUCTO, division_code: "H", comision_total: 225, semana: "2026-06-30", periodo_fin: "2026-06-30" },
    { ...PRODUCTO, division_code: "A", semana: "2026-07-01", periodo_fin: "2026-07-03" }
  ],
  diario: [
    { ...PRODUCTO, division_code: "H", fecha: "2026-06-30", asignacion: "Cierre de mes asignado" },
    { ...PRODUCTO, division_code: "A", fecha: "2026-07-01", asignacion: "Ventana del pago" }
  ],
  factura: [
    {
      ...PRODUCTO,
      division_code: "A",
      billing_document: "9001",
      item_number: "10",
      fecha: "2026-06-28",
      fecha_cobro: "2026-07-01",
      cantidad_venta: 10,
      cantidad_base: 300,
      monto: 100,
      comision: 450,
      se_cobro: true,
      monto_cobrado: 100,
      comision_cobrada: 450,
      asignacion: "Ventana del pago"
    }
  ]
} as unknown as CortesExportPagoResponse;

const PAGO = {
  pago_id: "DBC|2026|1",
  docs: ["DBC|2026|1"],
  documentos: [{ doc_id: "DBC|2026|1", documento: "5100000001", compensacion: "1500000001", texto: "COMISION HUEVO", fecha_pago: "2026-07-03" }],
  ini: "2026-07-01",
  fin: "2026-07-03",
  pagado: 1000,
  calculado: 1000,
  diferencia: 0,
  estado: "ok",
  dias_asignados: ["2026-06-30"],
  consolidado_por: null,
  consolidado_en: null
} as unknown as CortesPago;

describe("Excel de un pago de conciliación por cortes", () => {
  it("copia las hojas de la pestaña de conciliación, acotadas a la ventana y a los días de cierre asignados", async () => {
    const blob = await construirExcelPago(DATOS, {
      comisionista: "EDGARDO TRUJILLO",
      division: "Huevo + Abarrotes",
      pago: PAGO,
      modificaciones: [{ cuando: "20/10/26, 10:00", quien: "ana", que: "asignó los días de cierre 30 jun" }]
    });
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(await blob.arrayBuffer());
    expect(libro.worksheets.map((h) => h.name)).toEqual(["Resumen", "Conciliación", "Pagado vs. calculado", "Detalle diario", "Detalle de factura"]);

    // hoja de entrada: pagado, calculado y diferencia en tarjetas, el estado y lo hecho a mano
    const resumen = libro.getWorksheet("Resumen")!;
    expect([1, 3, 5].map((c) => resumen.getRow(4).getCell(c).value)).toEqual(["PAGADO", "CALCULADO", "DIFERENCIA"]);
    expect([1, 3, 5].map((c) => resumen.getRow(5).getCell(c).value)).toEqual([1000, 1000, 0]);
    expect(resumen.getRow(8).getCell(2).value).toBe("Cuadra");
    const texto: string[] = [];
    resumen.eachRow((f) => f.eachCell((c) => texto.push(String(c.value))));
    expect(texto.some((t) => t.includes("2026-06-30") && t.includes("incluidos en este pago"))).toBe(true);
    expect(texto).toContain("asignó los días de cierre 30 jun");

    // hojas con título en la fila 1, encabezado en la 4, total en la 5 (SUBTOTAL) y datos desde la 6
    const conc = libro.getWorksheet("Conciliación")!;
    expect(conc.getRow(1).getCell(1).value).toBe("Conciliación de comisión — EDGARDO TRUJILLO · Huevo + Abarrotes");
    expect(conc.getRow(4).getCell(1).value).toBe("Periodo");
    expect(conc.getRow(6).getCell(1).value).toBe("2026-06-30 - 2026-06-30");
    expect(conc.getRow(7).getCell(1).value).toBe("2026-07-01 - 2026-07-03");
    expect(conc.getRow(5).getCell(1).value).toBe("TOTAL");

    const pagado = libro.getWorksheet("Pagado vs. calculado")!;
    expect([1, 2, 3, 4].map((c) => pagado.getRow(6).getCell(c).value)).toEqual(["2026-07-01 - 2026-07-03", 1000, 1000, 0]);

    const diario = libro.getWorksheet("Detalle diario")!;
    expect(diario.getRow(4).getCell(1).value).toBe("Fecha");
    expect(diario.getRow(6).getCell(1).value).toBe("2026-06-30");
    expect(diario.getRow(7).getCell(1).value).toBe("2026-07-01");

    const factura = libro.getWorksheet("Detalle de factura")!;
    expect(factura.getRow(6).getCell(1).value).toBe("9001");
    expect(factura.getRow(4).getCell(factura.columnCount).value).toBe("Fecha de cobro");
  });
});
