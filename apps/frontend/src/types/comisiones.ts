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
 * Cantidades por unidad de manejo (caja/saco/paquete/pieza según división).
 * NO se pueden sumar entre unidades distintas -- el gráfico sí suma entre
 * divisiones que comparten unidad (ej. Abarrotes y Leche, ambas "pieza"), la
 * tabla usa `division`/`division_code` para distinguirlas.
 */
export type FlujoCantidadUnidadRow = {
  fase: string;
  division_code: string | null;
  division: string | null;
  unidad: string;
  cantidad_total: number;
};

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
  /** Lo que además tiene un pago registrado. NO es lo pagable: la fuente de
   *  cobro (`sap_bsad_cleared_items`) no ve el 100% del facturado. Es el suelo conocido. */
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

// ─── Conciliación por comisionista (M3) — reemplaza al M3 documental ───────
//
// El plan original (bajar de un pago agregado en BSIK a factura/material, con
// "confianza" de match) se abandonó el 2026-09-02: no existe esa fuente en
// BigQuery (Datos/Comisiones_DBC_Borrador_Tecnico.md, sección 16.3). Esto es
// otra cosa: reproducir, automáticamente, la hoja que hoy arma a mano quien
// concilia — producto por producto, semana por semana — para que solo tenga
// que comparar el total contra lo que le pagaron, no reconstruir la hoja.

export type ConciliacionFilters = {
  division: string | null;
  comisionista: string | null;
  /** ISO `YYYY-MM-DD`. La tabla de origen agrupa por PERIODO DE PAGO, no
   *  semana a secas: normalmente sábado-viernes (7 días), pero se corta antes
   *  si cruza de mes (supuesto pendiente de confirmar con el cliente — ver
   *  `ConciliacionDetalleRow.semana`). */
  start_date: string;
  end_date: string;
};

/** Nivel 1 de la pantalla: a quién hay que pagarle. Una fila por
 *  (comisionista, división) — la misma persona cobra cada división aparte. */
export type ConciliacionPorComisionista = {
  comisionista: string | null;
  division_code: string | null;
  division: string | null;
  num_lineas: number;
  monto_total: number;
  comision_total: number;
  /** Cantidad entregada con importe cero — no es un error, ver comisiones. */
  lineas_sin_comision: number;
  num_semanas: number;
};

/** Nivel 2: una fila por producto — el mismo grano que ella escribe a mano.
 *  `matnr` es de SAP; `descripcion` sale de MAKT (SPRAS='S'), no siempre
 *  necesaria para leer la fila pero sí para justificarla ante Hacienda. */
export type ConciliacionDetalleRow = {
  /** Inicio del periodo de pago (normalmente el sábado, 7 días — pero puede
   *  arrancar el día 1 de un mes y durar más si absorbió los días sueltos del
   *  cierre anterior, ver ConciliacionFilters). */
  semana: string;
  /** Fin del periodo -- para mostrar el rango completo ("inicio - fin"), no
   *  solo el arranque, que por sí solo parece un único día. */
  periodo_fin: string;
  division_code: string | null;
  division: string | null;
  cedis: string | null;
  oficina: string | null;
  comisionista: string | null;
  tipo_venta: string | null;
  matnr: string;
  descripcion: string | null;
  /** Unidad de manejo del material (caja/saco/paquete/pieza según división),
   *  no la unidad SAP cruda de la línea. */
  unidad_venta: string | null;
  /** La que multiplica la tarifa: `kg` en H/IA, igual a `unidad_venta` en
   *  BO/A/L (no hay conversión real ahí). Confirmado 2026-09-07. */
  unidad_tarifa: string | null;
  tarifa: number | null;
  num_lineas: number;
  cantidad_venta_total: number | null;
  monto_total: number;
  cantidad_base_total: number | null;
  comision_total: number;
  lineas_sin_comision: number;
};

export type ConciliacionResponse = {
  cobertura: { desde?: string; hasta?: string };
  por_comisionista: ConciliacionPorComisionista[];
  /** Sin agregar más allá del grano de producto: filtrado a un comisionista y
   *  unas semanas son decenas de filas, así que la pantalla arma la cascada
   *  CEDIS → oficina → tipo de venta agrupando esto en memoria. */
  detalle: ConciliacionDetalleRow[];
};

/** Mismo grano que `ConciliacionDetalleRow` pero por día (`fecha`) en vez de
 *  periodo de pago -- la transparencia para el borde de mes: el periodo
 *  agregado es un supuesto, así que el Excel también trae el desglose día por
 *  día para verificar o ajustar a mano si un caso concreto no encaja. Se pide
 *  aparte (no viene en `ConciliacionResponse`) porque solo hace falta al
 *  exportar UN comisionista, no en cada carga de pantalla. */
export type ConciliacionDiarioRow = Omit<ConciliacionDetalleRow, "semana"> & { fecha: string };

/** Un renglón por línea de factura real -- el nivel de trazabilidad máximo:
 *  de la comisión calculada a la factura exacta que la compone. A diferencia
 *  de `ConciliacionDetalleRow`/`ConciliacionDiarioRow`, sí trae cobro
 *  (`se_cobro`/`monto_cobrado`/`comision_cobrada`): es la excepción a
 *  propósito a "en pausa perseguir cobro" (2026-09-02) -- cuando se pueda
 *  calcular comisión sobre lo cobrado, sale de esta fuente. */
export type ConciliacionFacturaRow = {
  billing_document: string;
  item_number: string;
  fecha: string;
  division_code: string | null;
  division: string | null;
  cedis: string | null;
  oficina: string | null;
  comisionista: string | null;
  tipo_venta: string | null;
  matnr: string;
  descripcion: string | null;
  unidad_venta: string | null;
  cantidad_venta: number | null;
  unidad_tarifa: string | null;
  cantidad_base: number | null;
  tarifa: number | null;
  monto: number;
  comision: number;
  comision_estado: string | null;
  se_cobro: boolean;
  monto_cobrado: number | null;
  cantidad_cobrada: number | null;
  comision_cobrada: number | null;
  fecha_cobro: string | null;
};

export const EMPTY_CONCILIACION: ConciliacionResponse = {
  cobertura: {},
  por_comisionista: [],
  detalle: []
};
