// Tipos del dominio de Comisiones DBC. Ver Datos/Comisiones_DBC_Borrador_Tecnico.md
// para el mapeo de datos completo (fuentes, cobertura, pendientes).

// ─── Catálogo (M0) — división + CEDIS, ya resuelto y validado ──────────────

// `dm_business_area` se consulta con SELECT * (ver catalog_engine.py: el
// nombre exacto de la columna descriptiva todavía no está verificado contra
// el esquema real), así que el frontend no asume columnas fijas.
export type DivisionRow = Record<string, string | number | boolean | null>;

export type CedisRow = {
  cedis: string;
  sector: string | null;
  almacen: string | null;
  oficina: string | null;
  tipo_venta: string | null;
};

export type ComisionesCatalog = {
  divisiones: DivisionRow[];
  cedis: CedisRow[];
};

export const EMPTY_CATALOG: ComisionesCatalog = { divisiones: [], cedis: [] };

// ─── Comisiones (M2) — bloqueado: falta GS03 (SETs) y ZSDFI_001 (tarifas) ──

export type ReportFilters = {
  division: string | null;
  cedis: string | null;
  start_period: string;
  end_period: string;
};

export type ReportRow = {
  division: string;
  cedis: string;
  comisionista: string;
  vendido: number;
  facturado: number;
  cobrado: number;
  comision_devengada: number;
  comision_pagable: number;
};

export type ReportResponse = {
  filas: ReportRow[];
  vendido_total: number;
  facturado_total: number;
  cobrado_total: number;
  comision_pagable_total: number;
};

// ─── Conciliación documental (M3) — el módulo menos avanzado ───────────────

export type ReconciliationFilters = {
  provider_id: string | null;
  start_period: string;
  end_period: string;
};

export type ReconciliationConfidence = "alta" | "media" | "baja";
export type ReconciliationStatus = "conciliado" | "revisar" | "pendiente";

export type ReconciliationItem = {
  id: string;
  comisionista: string;
  proveedor_id: string;
  factura_serie: string | null;
  factura_folio: string;
  periodo: string;
  monto_factura: number;
  monto_pagado: number | null;
  confianza: ReconciliationConfidence;
  estado: ReconciliationStatus;
};

export type ReconciliationEvidencia = { etiqueta: string; valor: string };

export type ReconciliationDetail = ReconciliationItem & {
  documento_pago: string | null;
  fecha_pago: string | null;
  diferencia: number | null;
  evidencia: ReconciliationEvidencia[];
  notas: string | null;
};

export type ReconciliationResponse = {
  filas: ReconciliationItem[];
  detalle: Record<string, ReconciliationDetail>;
  conciliados: number;
  por_revisar: number;
  pendientes: number;
};
