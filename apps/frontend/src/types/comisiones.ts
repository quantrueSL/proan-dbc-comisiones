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
  /** Cantidad en la unidad de manejo del material — la única comparable entre
   *  unidades. Ya viene en las tres fases. `null` sigue significando "aquí no
   *  aplica", que no es lo mismo que cero. */
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
 * Hasta qué fecha hay datos de cada fase, y no tienen por qué coincidir: la
 * carga de sap_VBAP se ha quedado atrás más de una vez y "vendido" termina
 * antes que las otras dos (ver data/notas/hallazgos.md). Sin esto la pantalla
 * dibujaría ceros donde falta el dato y parecería un desplome de ventas.
 */
export type FlujoCobertura = Record<string, { desde: string; hasta: string }>;

/** `division_code` es lo que se filtra; `division` es lo que se enseña. */
export type FlujoPorDivisionRow = FlujoTotales & {
  division_code: string | null;
  division: string | null;
  fase: string;
};
export type FlujoPorTipoVentaRow = FlujoTotales & { tipo_venta: string | null; fase: string };

/**
 * Lo que la pantalla deja fuera: los cuatro almacenes centrales que no pasan
 * por ningún CEDIS. Viene calculado del backend y no escrito a mano, para que
 * la nota de la pantalla no envejezca mintiendo.
 */
export type FlujoExcluido = FlujoTotales & { pct_del_total: number };

export type FlujoResponse = {
  cobertura: FlujoCobertura;
  excluido_almacen_central: FlujoExcluido;
  resumen: FlujoResumenRow[];
  por_fecha: FlujoPorFechaRow[];
  por_cedis: FlujoPorCedisRow[];
  por_division: FlujoPorDivisionRow[];
  por_tipo_venta: FlujoPorTipoVentaRow[];
  cantidad_por_unidad: FlujoCantidadUnidadRow[];
};

export const EMPTY_FLUJO: FlujoResponse = {
  cobertura: {},
  excluido_almacen_central: {
    num_lineas: 0,
    monto_total: 0,
    cantidad_cajas_total: null,
    pct_del_total: 0
  },
  resumen: [],
  por_fecha: [],
  por_cedis: [],
  por_division: [],
  por_tipo_venta: [],
  cantidad_por_unidad: []
};

// ─── Comisiones (M2) — ya calcula, pero solo sobre parte del facturado ────
//
// El módulo estuvo bloqueado hasta el 24 de agosto de 2026, cuando el cliente
// mandó los SETs y las tarifas. Hoy calcula, pero solo el 44% del facturado en
// alcance llega a tener tarifa aplicable: el resto está esperando respuestas
// concretas. Por eso `bloqueado` no es un extra de la respuesta — es la mitad
// que hace legible a la otra.

export type ReportFilters = {
  division: string | null;
  cedis: string | null;
  comisionista: string | null;
  start_date: string;
  end_date: string;
};

/** Los mismos totales para cualquier agrupación. */
export type ComisionTotales = {
  num_lineas: number;
  monto: number;
  comision: number;
  /** Lo que además tiene un pago registrado. NO es lo pagable: `sap_pago` solo
   *  ve el 27% del facturado. Es el suelo conocido. */
  comision_con_cobro: number;
  /** Del importe del grupo, cuánto llegó a tener tarifa. Sin esto, poca venta y
   *  media venta bloqueada se ven igual. */
  monto_calculable: number;
};

export type ComisionPorComisionista = ComisionTotales & { comisionista: string | null };
export type ComisionPorDivision = ComisionTotales & {
  division_code: string | null;
  division: string | null;
};
export type ComisionPorCedis = ComisionTotales & { cedis: string | null };
export type ComisionPorSet = ComisionTotales & { set: string | null };
/** `null` = la línea no trae tipo de venta, no es un tipo llamado "ninguno". */
export type ComisionPorTipoVenta = ComisionTotales & { tipo_venta: string | null };
export type ComisionPorFecha = ComisionTotales & { fecha: string };

/**
 * Una fila del desglose: el grano más fino que tiene sentido enseñar, que es la
 * llave de la tarifa (división + oficina + SET + tipo de venta). Por debajo no
 * hay nada que cuadrar contra la hoja del cliente; por encima hay sumas que no
 * se pueden verificar contra nada.
 *
 * Las dos cascadas de la pantalla son anidamientos distintos de estas mismas
 * columnas, así que este único array las sirve a las dos y abrir un nodo no
 * pide nada al servidor.
 */
export type ComisionDesgloseRow = ComisionTotales & {
  comisionista: string | null;
  division_code: string | null;
  division: string | null;
  cedis: string | null;
  oficina: string | null;
  set: string | null;
  tipo_venta: string | null;
  /** `kg` o `caja`. Va en la llave: sin ella la cantidad mezcla unidades. */
  base_unidad: string | null;
  /** Lo que multiplica la tarifa. Solo se puede sumar entre filas de la MISMA
   *  `base_unidad` — por eso la cascada la deja en blanco por encima de la
   *  división, que es donde deja de haber una sola unidad. */
  cantidad_base: number;
};

/** Por qué un trozo del facturado no llega a tener comisión, y cuánto vale. */
export type ComisionBloqueo = {
  motivo: string;
  num_lineas: number;
  monto: number;
  /** Solo tienen valor donde las dos hojas de tarifas del cliente se
   *  contradicen: ahí no hay una cifra, hay un rango. */
  comision_min: number;
  comision_max: number;
};

export type ReportResponse = {
  cobertura: { desde?: string; hasta?: string };
  totales: ComisionTotales & { pct_calculable: number; lineas_sin_importe: number };
  por_comisionista: ComisionPorComisionista[];
  por_division: ComisionPorDivision[];
  por_cedis: ComisionPorCedis[];
  por_set: ComisionPorSet[];
  por_tipo_venta: ComisionPorTipoVenta[];
  por_fecha: ComisionPorFecha[];
  desglose: ComisionDesgloseRow[];
  /** La cantidad NO se suma entre unidades: huevo se comisiona por kilo y el
   *  resto por caja. Viaja siempre desglosada. */
  cantidad_por_unidad: { base_unidad: string; cantidad: number }[];
  bloqueado: ComisionBloqueo[];
};

export const EMPTY_REPORT: ReportResponse = {
  cobertura: {},
  totales: {
    num_lineas: 0,
    monto: 0,
    comision: 0,
    comision_con_cobro: 0,
    monto_calculable: 0,
    pct_calculable: 0,
    lineas_sin_importe: 0
  },
  por_comisionista: [],
  por_division: [],
  por_cedis: [],
  por_set: [],
  por_tipo_venta: [],
  por_fecha: [],
  desglose: [],
  cantidad_por_unidad: [],
  bloqueado: []
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
