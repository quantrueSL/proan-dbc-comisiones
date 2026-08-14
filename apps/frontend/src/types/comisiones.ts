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

// ─── Flujo de producto (M0) — vendido, facturado y cobrado ────────────────
// Sale de ZZ_PRUEBAS.DBC_gold_flujo_producto_diario (ver flujo_engine.py).
// Falta la cuarta capa, traspasos: depende de validar sap_mseg contra MB51.

export type FlujoFilters = {
  division: string | null;
  cedis: string | null;
  tipo_venta?: string | null;
  /** ISO `YYYY-MM-DD`: la tabla de origen es diaria. */
  start_date: string;
  end_date: string;
};

export type FlujoTotales = {
  num_lineas: number;
  monto_total: number;
  /** Solo la fase "facturado" trae cajas. `null` significa "aquí no aplica", no cero. */
  cantidad_cajas_total: number | null;
};

export type FlujoResumenRow = FlujoTotales & { fase: string };
export type FlujoPorFechaRow = FlujoTotales & { fecha: string; fase: string };
/** `cedis` es null cuando la combinación almacén+oficina no está en dm_cedis. */
export type FlujoPorCedisRow = FlujoTotales & { cedis: string | null; fase: string };

/**
 * Cantidades desglosadas por unidad. NO se pueden sumar entre unidades: vienen
 * en CS, PZA, PAQ, SAC, KG... Por eso llegan separadas y no como un total.
 */
export type FlujoCantidadUnidadRow = { fase: string; unidad: string; cantidad_total: number };

/**
 * Hasta qué fecha hay datos de cada fase. Hoy NO coinciden: sap_VBAP no recibe
 * datos desde el 20/07/2026, así que "vendido" se corta ahí mientras facturado
 * y cobrado siguen. Sin esto la pantalla dibujaría ceros y parecería un
 * desplome de ventas — ver data/notas/07.
 */
export type FlujoCobertura = Record<string, { desde: string; hasta: string }>;

/** `division_code` es lo que se filtra; `division` es lo que se enseña. */
export type FlujoPorDivisionRow = FlujoTotales & {
  division_code: string | null;
  division: string | null;
  fase: string;
};
export type FlujoPorTipoVentaRow = FlujoTotales & { tipo_venta: string | null; fase: string };

export type FlujoResponse = {
  cobertura: FlujoCobertura;
  resumen: FlujoResumenRow[];
  por_fecha: FlujoPorFechaRow[];
  por_cedis: FlujoPorCedisRow[];
  por_division: FlujoPorDivisionRow[];
  por_tipo_venta: FlujoPorTipoVentaRow[];
  cantidad_por_unidad: FlujoCantidadUnidadRow[];
};

export const EMPTY_FLUJO: FlujoResponse = {
  cobertura: {},
  resumen: [],
  por_fecha: [],
  por_cedis: [],
  por_division: [],
  por_tipo_venta: [],
  cantidad_por_unidad: []
};

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
