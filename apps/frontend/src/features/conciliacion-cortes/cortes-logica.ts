// Lógica pura de la pestaña de conciliación por cortes: columnas del mes,
// posición de cada pago, totales de la cabecera, filtros y qué mostrar en la
// línea de tiempo. Sin React ni red, para poder probarla sola.
import type {
  CortesEstado,
  CortesFila,
  CortesHueco,
  CortesMesResponse,
  CortesPago,
  CortesSugerencia
} from "@/types/comisiones";

const DIA_MS = 86_400_000;

export const ETIQUETA_ESTADO: Record<CortesEstado, string> = {
  ok: "Cuadra",
  sug: "Sugerencia",
  sin: "Sin explicación",
  sinv: "Sin ventana",
  cons: "Consolidado"
};

/** Para los totales de la cabecera: en plural, porque cuentan pagos. */
export const ETIQUETA_TOTAL: Record<CortesEstado, string> = {
  ok: "Cuadran",
  sug: "Con sugerencia",
  sin: "Sin explicación",
  sinv: "Sin ventana",
  cons: "Consolidados"
};

// ─── Fechas ──────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` a milisegundos UTC: sin zona horaria no se pierde un día. */
export function aMs(iso: string): number {
  const [a, m, d] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

export function deMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function sumarDias(iso: string, dias: number): string {
  return deMs(aMs(iso) + dias * DIA_MS);
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((aMs(hasta) - aMs(desde)) / DIA_MS);
}

// A mano, no con Intl: el servidor y el navegador pueden formatear distinto ("vie 3 jul"
// o "vie 3 de jul") y eso rompe la hidratación.
const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "3 jul". */
export function fechaCorta(iso: string): string {
  const f = new Date(aMs(iso));
  return `${f.getUTCDate()} ${MESES_CORTOS[f.getUTCMonth()]}`;
}

/** "vie 3 jul". */
export function fechaConDia(iso: string): string {
  return `${DIAS_CORTOS[new Date(aMs(iso)).getUTCDay()]} ${fechaCorta(iso)}`;
}

/** "27 jun a 3 jul". */
export function rangoCorto(ini: string, fin: string): string {
  return `${fechaCorta(ini)} a ${fechaCorta(fin)}`;
}

// ─── Dinero ──────────────────────────────────────────────────────────────

const dinero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });

export function pesos(valor: number): string {
  return `$${dinero.format(valor)}`;
}

/** Con signo explícito: en una columna de diferencia "1,234" y "-1,234" se confunden. */
export function pesosConSigno(valor: number): string {
  return `${valor >= 0 ? "+" : "-"}$${dinero.format(Math.abs(valor))}`;
}

/** Diferencia lista para mostrar: "$0" si cuadra (±$1), con signo si no, "—" si no hay. */
export function textoDiferencia(valor: number | null): string {
  if (valor === null) return "—";
  return Math.abs(valor) <= 1 ? "$0" : pesosConSigno(valor);
}

// ─── Columnas del mes ────────────────────────────────────────────────────

export type SemanaColumna = { ini: string; fin: string };

/** Semanas sábado-viernes que tocan el mes `AAAA-MM`, incluida la que arranca el mes anterior. */
export function semanasDelMes(mes: string): SemanaColumna[] {
  const [a, m] = mes.split("-").map(Number);
  const primero = Date.UTC(a, m - 1, 1);
  const ultimo = Date.UTC(a, m, 0);
  const diaSemana = new Date(primero).getUTCDay(); // 0 domingo ... 6 sábado
  let ini = primero - ((diaSemana + 1) % 7) * DIA_MS;
  const semanas: SemanaColumna[] = [];
  while (ini <= ultimo) {
    semanas.push({ ini: deMs(ini), fin: deMs(ini + 6 * DIA_MS) });
    ini += 7 * DIA_MS;
  }
  return semanas;
}

function indiceSemana(semanas: SemanaColumna[], iso: string): number {
  const i = semanas.findIndex((s) => iso >= s.ini && iso <= s.fin);
  if (i >= 0) return i;
  return iso < semanas[0].ini ? 0 : semanas.length - 1;
}

export type PagoPosicionado = { pago: CortesPago; colIni: number; colFin: number };

/**
 * Columna (en semanas) de cada pago con ventana: termina en la semana de su fin y
 * empieza donde acabó el anterior, así un pago acumulado ocupa varias columnas
 * y dos pagos nunca se montan. El primero arranca en la semana de su inicio.
 */
export function posicionarPagos(pagos: CortesPago[], semanas: SemanaColumna[]): PagoPosicionado[] {
  const conVentana = pagos
    .filter((p) => p.ini !== null && p.fin !== null)
    .sort((a, b) => (a.ini! < b.ini! ? -1 : a.ini! > b.ini! ? 1 : a.fin! < b.fin! ? -1 : 1));
  const ultima = semanas.length - 1;
  let anterior = -1;
  return conVentana.map((pago, i) => {
    const colIni = i === 0 ? indiceSemana(semanas, pago.ini!) : Math.min(anterior + 1, ultima);
    const colFin = Math.min(Math.max(indiceSemana(semanas, pago.fin!), colIni), ultima);
    anterior = colFin;
    return { pago, colIni, colFin };
  });
}

// ─── Filtros y totales ───────────────────────────────────────────────────

export type FiltrosCortes = {
  division: string;
  comisionistaId: string;
  soloAccion: boolean;
};

export function filaTodoCuadra(fila: CortesFila): boolean {
  return fila.pagos.every((p) => p.estado === "ok" || p.estado === "cons");
}

/** Filas visibles. La seleccionada se queda aunque "solo lo que requiere acción" la ocultaría. */
export function filtrarFilas(filas: CortesFila[], filtros: FiltrosCortes, seleccionadaId?: string | null): CortesFila[] {
  return filas.filter((f) => {
    if (filtros.division && f.division_code !== filtros.division && !(f.junta_con ?? []).includes(filtros.division)) return false;
    if (filtros.comisionistaId && f.comisionista_id !== filtros.comisionistaId) return false;
    if (filtros.soloAccion && filaTodoCuadra(f) && f.fila_id !== seleccionadaId) return false;
    return true;
  });
}

// ─── Tabla por comisionista ──────────────────────────────────────────────

export type GrupoComisionista = {
  /** El número de proveedor: un comisionista con filas en DBC y en PAN es un solo grupo. */
  clave: string;
  nombre: string;
  filas: CortesFila[];
};

/** Las filas agrupadas por comisionista (sin importar la sociedad), en el orden en que llegan (ya vienen ordenadas por nombre); dentro de cada una, las divisiones van siempre en el mismo orden. */
export function agruparPorComisionista(filas: CortesFila[]): GrupoComisionista[] {
  const grupos = new Map<string, GrupoComisionista>();
  for (const f of filas) {
    const clave = f.comisionista_id;
    const g = grupos.get(clave) ?? { clave, nombre: nombreComisionista(f), filas: [] };
    g.filas.push(f);
    grupos.set(clave, g);
  }
  // Mismo orden de divisiones en todos los comisionistas (sociedad y luego división) para comparar de un vistazo.
  const orden = (f: CortesFila) => `${f.sociedad}|${f.division_code}`;
  return Array.from(grupos.values()).map((g) => ({ ...g, filas: [...g.filas].sort((x, y) => orden(x).localeCompare(orden(y))) }));
}

export type TotalColumna = { n: number; pagado: number; calculado: number };

/**
 * Pagado y calculado de un comisionista por columna del mes (una por semana y, al final, "sin ventana").
 * Un pago cuenta en la columna donde termina, aunque abarque varias.
 */
export function totalesPorColumna(filas: CortesFila[], semanas: SemanaColumna[]): TotalColumna[] {
  const columnas: TotalColumna[] = Array.from({ length: semanas.length + 1 }, () => ({ n: 0, pagado: 0, calculado: 0 }));
  for (const fila of filas) {
    for (const { pago, colFin } of posicionarPagos(fila.pagos, semanas)) {
      const c = columnas[colFin];
      c.n += 1;
      c.pagado += pago.pagado;
      c.calculado += pago.calculado ?? 0;
    }
    for (const pago of fila.pagos) {
      if (pago.estado !== "sinv") continue;
      const c = columnas[semanas.length];
      c.n += 1;
      c.pagado += pago.pagado;
    }
  }
  return columnas;
}

/**
 * Columnas que se dibujan juntas con la siguiente: aquellas donde hay más pagos que las cruzan y terminan en la de al lado
 * (p. ej. "22-31 ago" cubre 22-28 y 29-31) que pagos que terminan en ella misma. Los totales de la columna unida suman las dos.
 * Devuelve el índice de la primera de cada par.
 */
export function columnasUnidas(filas: CortesFila[], semanas: SemanaColumna[]): Set<number> {
  const cruzan = Array.from({ length: semanas.length }, () => 0);
  const terminan = Array.from({ length: semanas.length }, () => 0);
  for (const fila of filas) {
    for (const { colIni, colFin } of posicionarPagos(fila.pagos, semanas)) {
      terminan[colFin] += 1;
      if (colFin > colIni) cruzan[colFin - 1] += 1; // lo que cruza hacia la siguiente, contado en la columna de antes
    }
  }
  const unidas = new Set<number>();
  for (let i = 0; i < semanas.length - 1; i++) {
    if (unidas.has(i - 1)) continue; // la segunda de un par no se vuelve a unir con la siguiente
    if (cruzan[i] > terminan[i]) unidas.add(i);
  }
  return unidas;
}

/**
 * Lo que enseñan, atenuado, las columnas que cubre un pago que termina en otra: el pagado y calculado de esos pagos.
 * No se suma a los totales (cada pago cuenta una vez, donde termina); es para que la columna no salga vacía.
 */
export function totalesCubiertos(filas: CortesFila[], semanas: SemanaColumna[]): (TotalColumna & { hasta: number })[] {
  const columnas = Array.from({ length: semanas.length }, () => ({ n: 0, pagado: 0, calculado: 0, hasta: -1 }));
  for (const fila of filas) {
    for (const { pago, colIni, colFin } of posicionarPagos(fila.pagos, semanas)) {
      for (let c = colIni; c < colFin; c++) {
        columnas[c].n += 1;
        columnas[c].pagado += pago.pagado;
        columnas[c].calculado += pago.calculado ?? 0;
        columnas[c].hasta = colFin;
      }
    }
  }
  return columnas;
}

/** Pagos que piden que alguien haga algo: una sugerencia por revisar o un pago sin explicación. */
export function esPendiente(pago: CortesPago): boolean {
  return pago.estado === "sug" || pago.estado === "sin";
}

/** Un consolidado con datos nuevos (cobros o pago en SAP) desde que se congeló. */
export function hayDrift(pago: CortesPago): boolean {
  return pago.estado === "cons" && (Math.abs(pago.drift ?? 0) > 1 || Math.abs(pago.drift_pagado ?? 0) > 1);
}

/** Lo que "Consolidar lo que cuadra" cerraría en las filas dadas: pagos y filas (el plan lo arma el servidor). */
export function resumenLote(filas: CortesFila[], rango?: { ini: string; fin: string }): { pagos: number; filas: number } {
  // Con `rango`, solo cuentan los pagos que tocan esas fechas (el mes elegido, no sus semanas de contexto).
  const delRango = (f: CortesFila) =>
    (f.lote ?? []).filter((id) => {
      const p = f.pagos.find((x) => x.pago_id === id);
      return !rango || !p || !p.ini || !p.fin || (p.ini <= rango.fin && p.fin >= rango.ini);
    });
  const conLote = filas.map(delRango).filter((l) => l.length > 0);
  return { pagos: conLote.reduce((n, l) => n + l.length, 0), filas: conLote.length };
}

export type RefPago = { filaId: string; pagoId: string };

/**
 * Todos los pagos en el orden en que se recorre la tabla: comisionista por comisionista, división por
 * división y, dentro de cada una, de la semana más antigua a la más reciente (los pagos sin ventana, al final).
 */
export function colaDePagos(grupos: GrupoComisionista[], semanas: SemanaColumna[]): RefPago[] {
  const cola: RefPago[] = [];
  for (const g of grupos) {
    for (const fila of g.filas) {
      for (const { pago } of posicionarPagos(fila.pagos, semanas)) cola.push({ filaId: fila.fila_id, pagoId: pago.pago_id });
      for (const pago of fila.pagos) if (pago.estado === "sinv") cola.push({ filaId: fila.fila_id, pagoId: pago.pago_id });
    }
  }
  return cola;
}

/** El siguiente pago pendiente después de `actual` (da la vuelta al final); `null` si ya no queda ninguno. */
export function siguientePendiente(
  cola: RefPago[],
  actual: RefPago | null,
  pendiente: (ref: RefPago) => boolean
): RefPago | null {
  if (!cola.length) return null;
  const i = actual ? cola.findIndex((r) => r.filaId === actual.filaId && r.pagoId === actual.pagoId) : -1;
  for (let k = 1; k <= cola.length; k++) {
    const candidato = cola[(i + k + cola.length) % cola.length];
    if (pendiente(candidato)) return candidato;
  }
  return null;
}

/** Calculado de cada división de origen dentro de una ventana (para el desglose Huevo + Abarrotes). */
export function calculadoPorParte(partes: Record<string, [string, number][]> | undefined, ini: string, fin: string): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const [origen, dias] of Object.entries(partes ?? {})) {
    salida[origen] = Math.round(dias.reduce((s, [fecha, monto]) => (fecha >= ini && fecha <= fin ? s + monto : s), 0) * 100) / 100;
  }
  return salida;
}

export type TotalEstado = { n: number; pagado: number; calculado: number; difAbs: number };

export type TotalesCortes = {
  porEstado: Record<CortesEstado, TotalEstado>;
  /** Cobros que ningún pago cubre (huecos entre pagos con comisión), dentro del mes. No incluye el cierre de mes. */
  sinPago: { n: number; comision: number };
  /** Lo cobrado el último día del mes, que va con el pago de la semana siguiente. */
  cierre: { n: number; comision: number };
  totalPagos: number;
};

const vacio = (): TotalEstado => ({ n: 0, pagado: 0, calculado: 0, difAbs: 0 });

function huecoToca(h: CortesHueco, desde: string, hasta: string): boolean {
  return h.ini <= hasta && h.fin >= desde;
}

/** Totales de la cabecera sobre las filas ya filtradas; `desde`/`hasta` acotan los huecos al mes. */
export function totalesCortes(filas: CortesFila[], desde: string, hasta: string): TotalesCortes {
  const porEstado: Record<CortesEstado, TotalEstado> = {
    ok: vacio(),
    sug: vacio(),
    sin: vacio(),
    sinv: vacio(),
    cons: vacio()
  };
  const sinPago = { n: 0, comision: 0 };
  const cierre = { n: 0, comision: 0 };
  let totalPagos = 0;
  for (const fila of filas) {
    for (const p of fila.pagos) {
      const t = porEstado[p.estado];
      t.n += 1;
      t.pagado += p.pagado;
      t.calculado += p.calculado ?? 0;
      t.difAbs += Math.abs(p.diferencia ?? 0);
      totalPagos += 1;
    }
    for (const h of fila.huecos) {
      if (h.comision > 0 && huecoToca(h, desde, hasta)) {
        const destino = h.cierre ? cierre : sinPago;
        destino.n += 1;
        destino.comision += h.comision;
      }
    }
  }
  return { porEstado, sinPago, cierre, totalPagos };
}

/** Comisión calculada sin pago de una fila dentro del mes (para el aviso junto a su nombre). */
export function huecosDelMes(fila: CortesFila, desde: string, hasta: string): { n: number; comision: number } {
  const hs = fila.huecos.filter((h) => h.comision > 0 && !h.cierre && huecoToca(h, desde, hasta));
  return { n: hs.length, comision: hs.reduce((s, h) => s + h.comision, 0) };
}

/** Semanas de los 4 SKUs de Botana que nadie ha incluido en un pago y caen en las semanas que se ven. */
export function skusSinPagar(fila: CortesFila, desde: string, hasta: string): { n: number; comision: number } {
  const l = (fila.skus ?? []).filter((b) => !b.pago_id && b.ini <= hasta && b.fin >= desde);
  return { n: l.length, comision: l.reduce((t, b) => t + b.comision, 0) };
}

/** Huecos de cierre de mes con comisión que ningún pago de la fila ha incluido todavía. */
export function cierresSinAsignar(fila: CortesFila): CortesHueco[] {
  const asignados = new Set(fila.pagos.flatMap((p) => p.dias_asignados ?? []));
  return fila.huecos.filter((h) => {
    if (!h.cierre || h.comision <= 0) return false;
    for (let d = h.ini; d <= h.fin; d = sumarDias(d, 1)) if (!asignados.has(d)) return true;
    return false;
  });
}

// ─── Línea de tiempo ─────────────────────────────────────────────────────

/** Pagos con ventana ordenados como los muestra el panel. */
export function pagosOrdenados(fila: CortesFila): CortesPago[] {
  return fila.pagos
    .filter((p) => p.ini !== null && p.fin !== null)
    .sort((a, b) => (a.ini! < b.ini! ? -1 : a.ini! > b.ini! ? 1 : a.fin! < b.fin! ? -1 : 1));
}

/** El pago seleccionado y hasta `contexto` pagos vecinos a cada lado. */
export function pagosEnVista(fila: CortesFila, pagoId: string, contexto: number): CortesPago[] {
  const todos = pagosOrdenados(fila);
  const i = todos.findIndex((p) => p.pago_id === pagoId);
  if (i < 0) return [];
  return todos.slice(Math.max(0, i - contexto), i + contexto + 1);
}

export type ElementoLinea =
  | { tipo: "pago"; pago: CortesPago }
  | { tipo: "corte"; izq: string; fecha: string; congelado: boolean }
  | { tipo: "hueco"; ini: string; fin: string; comision: number; cierre: boolean; izq: string; der: string }
  | { tipo: "traslape"; ini: string; fin: string }
  // Dos pagos separados solo por días ya asignados a mano (el cierre de mes): sin hueco que dibujar, pero el fin del de la izquierda se puede mover.
  | { tipo: "salto"; izq: string; der: string };

/** Pagos en vista con lo que hay entre cada par: un corte compartido, un hueco o un traslape. */
export function elementosDeLinea(fila: CortesFila, vista: CortesPago[]): ElementoLinea[] {
  const salida: ElementoLinea[] = [];
  vista.forEach((pago, i) => {
    salida.push({ tipo: "pago", pago });
    const sig = vista[i + 1];
    if (!sig) return;
    const corte = fila.cortes.find((c) => c.izq === pago.pago_id && c.der === sig.pago_id);
    if (corte) {
      salida.push({ tipo: "corte", izq: corte.izq, fecha: corte.fecha, congelado: corte.congelado });
      return;
    }
    const hueco = fila.huecos.find((h) => h.despues_de === pago.pago_id && h.antes_de === sig.pago_id);
    if (hueco) {
      salida.push({ tipo: "hueco", ini: hueco.ini, fin: hueco.fin, comision: hueco.comision, cierre: hueco.cierre, izq: pago.pago_id, der: sig.pago_id });
      return;
    }
    const traslape = fila.traslapes.find((t) => t.pagos[0] === pago.pago_id && t.pagos[1] === sig.pago_id);
    if (traslape) {
      salida.push({ tipo: "traslape", ini: traslape.ini, fin: traslape.fin });
      return;
    }
    if (pago.fin && sig.ini && pago.fin < sig.ini) salida.push({ tipo: "salto", izq: pago.pago_id, der: sig.pago_id });
  });
  return salida;
}

/**
 * Hasta dónde se puede mover el fin del pago `izqId` cuando no comparte corte con el siguiente: no más atrás de su
 * inicio y no más adelante del día anterior al primero del siguiente (ni de un día que ese ya tiene asignado).
 */
export function limitesDeFin(fila: CortesFila, izqId: string, derId: string): { min: string; max: string } | null {
  const izq = fila.pagos.find((p) => p.pago_id === izqId);
  const der = fila.pagos.find((p) => p.pago_id === derId);
  if (!izq?.ini || !der?.ini) return null;
  const primero = [der.ini, ...(der.dias_asignados ?? [])].sort()[0];
  return { min: izq.ini, max: sumarDias(primero, -1) };
}

/** Días que cambian de pago si se aplica la sugerencia (se dibujan con borde punteado). */
export function diasQueCambian(s: CortesSugerencia | null): Set<string> {
  const dias = new Set<string>();
  if (!s) return dias;
  for (const d of s.dias_asignar ?? []) dias.add(d);
  for (const c of s.cambios) {
    const ini = c.de < c.a ? c.de : c.a;
    const fin = c.de < c.a ? c.a : c.de;
    // un borde `fin` que se mueve deja fuera (o mete) los días después del menor; uno `ini`, los anteriores al mayor
    const desde = c.borde === "fin" ? sumarDias(ini, 1) : ini;
    const hasta = c.borde === "fin" ? fin : sumarDias(fin, -1);
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) dias.add(d);
  }
  return dias;
}

/** Frase de una sugerencia de 4 SKUs: "incluir los 4 SKUs de 25 jul a 21 ago ($1,556) en este pago". */
export function describirSkus(s: CortesSugerencia, semanas: { ini: string; fin: string }[]): string {
  const inis = [...(s.bloques_asignar ?? [])].sort();
  const fines = inis.map((i) => semanas.find((b) => b.ini === i)?.fin ?? i);
  const monto = s.afectados.length ? s.afectados[0].diferencia_despues - s.afectados[0].diferencia_antes : null;
  const cuando = inis.length === 1 ? `de la semana del ${fechaCorta(inis[0])}` : `de las ${inis.length} semanas de ${rangoCorto(inis[0], fines[fines.length - 1])}`;
  return `incluir los 4 SKUs ${cuando}${monto === null ? "" : ` (${pesos(monto)})`} en este pago`;
}

/** Frase de una sugerencia de cierre: "incluir el cierre del vie 31 ago ($12,030) en este pago". */
export function describirCierre(s: CortesSugerencia): string {
  const monto = s.afectados.length ? s.afectados[0].diferencia_despues - s.afectados[0].diferencia_antes : null;
  const dias = [...(s.dias_asignar ?? [])].sort();
  // un día: "del lun 31 ago"; varios seguidos (el bloque de fin de mes): "del vie 29 ago al lun 31 ago"
  const cuando =
    dias.length > 1 ? `del ${fechaConDia(dias[0])} al ${fechaConDia(dias[dias.length - 1])}` : `del ${fechaConDia(dias[0] ?? "")}`;
  return `incluir el cierre ${cuando}${monto === null ? "" : ` (${pesos(monto)})`} en este pago`;
}

export type CorteMovido = {
  /** `corte`: el borde compartido de dos pagos; `fin`/`ini`: un borde suelto (extremo, hueco o traslape). */
  tipo: "corte" | "fin" | "ini";
  antes: string;
  despues: string;
};

/** Lo que mueve la sugerencia, sin repetir el corte de un par compartido ("corte del vie 3 al jue 2"). */
export function cortesMovidos(s: CortesSugerencia): CorteMovido[] {
  const salida: CorteMovido[] = [];
  const usados = new Set<number>();
  s.cambios.forEach((c, i) => {
    if (usados.has(i)) return;
    if (c.borde === "fin") {
      // el fin de un pago y el inicio del siguiente, un día después, son un solo corte
      const j = s.cambios.findIndex(
        (o, k) => k !== i && !usados.has(k) && o.borde === "ini" && o.de === sumarDias(c.de, 1) && o.a === sumarDias(c.a, 1)
      );
      if (j >= 0) {
        usados.add(j);
        salida.push({ tipo: "corte", antes: c.de, despues: c.a });
        return;
      }
      salida.push({ tipo: "fin", antes: c.de, despues: c.a });
    } else {
      salida.push({ tipo: "ini", antes: c.de, despues: c.a });
    }
  });
  return salida;
}

/** Frase corta de lo que mueve cada cambio de la sugerencia. */
export function describirMovimiento(m: CorteMovido): string {
  if (m.tipo === "corte") return `mover el corte del ${fechaConDia(m.antes)} al ${fechaConDia(m.despues)}`;
  if (m.tipo === "fin") return `terminar el pago el ${fechaConDia(m.despues)} en vez del ${fechaConDia(m.antes)}`;
  return `empezar el pago el ${fechaConDia(m.despues)} en vez del ${fechaConDia(m.antes)}`;
}

/** Nombre para mostrar: el del proveedor o, si no lo hay, su número. */
export function nombreComisionista(fila: Pick<CortesFila, "comisionista" | "comisionista_id">): string {
  return fila.comisionista?.trim() || `Proveedor ${fila.comisionista_id.replace(/^0+/, "")}`;
}

/**
 * Mes `AAAA-MM` con el que se abre la pestaña: el de hoy. Si todavía no tiene pagos con ventana (los pagos
 * se hacen los viernes y el mes recién empezó), la página abre el anterior; en cuanto entran los primeros
 * pagos del mes nuevo, la pestaña se abre en él.
 */
export function mesPorDefecto(hoyISO: string): string {
  return hoyISO.slice(0, 7);
}

// ─── Semanas a la vista ──────────────────────────────────────────────────

/** Las semanas sábado-viernes que se ven: desde el sábado `ini`, `n` semanas seguidas. El selector de mes la coloca y las flechas la desplazan. */
export type VistaSemanas = { ini: string; n: number };

/** El sábado de la semana (sábado a viernes) a la que pertenece un día. */
export function sabadoDeSemana(iso: string): string {
  const dia = new Date(aMs(iso)).getUTCDay(); // 0 domingo ... 6 sábado
  return sumarDias(iso, -((dia + 1) % 7));
}

/** Semanas de contexto que se ven antes y después del mes elegido. */
export const SEMANAS_DE_CONTEXTO = 2;

/**
 * Las semanas del mes (la primera arranca el sábado anterior al día 1 si hace falta) con 2 semanas de contexto a cada
 * lado. Con `hoy`, las semanas posteriores que todavía no empiezan no se enseñan.
 */
export function vistaDeMes(mes: string, hoy?: string): VistaSemanas {
  const semanas = semanasDelMes(mes);
  const ini = sumarDias(semanas[0].ini, -7 * SEMANAS_DE_CONTEXTO);
  let n = semanas.length + 2 * SEMANAS_DE_CONTEXTO;
  while (hoy && n > semanas.length + SEMANAS_DE_CONTEXTO && sumarDias(ini, 7 * (n - 1)) > hoy) n--;
  return { ini, n };
}

/** Primer y último día del mes `AAAA-MM`. */
export function rangoDelMes(mes: string): { ini: string; fin: string } {
  const [a, m] = mes.split("-").map(Number);
  return { ini: `${mes}-01`, fin: deMs(Date.UTC(a, m, 0)) };
}

/** Las columnas de la vista: una por semana sábado-viernes, pero la semana que cruza un fin de mes se parte ahí (29 a 31 ago, 1 a 4 sep). */
export function semanasDeVista(v: VistaSemanas): SemanaColumna[] {
  const columnas: SemanaColumna[] = [];
  for (let i = 0; i < v.n; i++) {
    const ini = sumarDias(v.ini, 7 * i);
    const fin = sumarDias(ini, 6);
    if (ini.slice(0, 7) === fin.slice(0, 7)) {
      columnas.push({ ini, fin });
      continue;
    }
    const primeroDelSiguiente = `${fin.slice(0, 7)}-01`;
    columnas.push({ ini, fin: sumarDias(primeroDelSiguiente, -1) }, { ini: primeroDelSiguiente, fin });
  }
  return columnas;
}

export function finDeVista(v: VistaSemanas): string {
  return sumarDias(v.ini, 7 * v.n - 1);
}

/** El mes que describe la vista: el de la mitad de la tercera semana del mes (las dos primeras columnas son contexto). */
export function mesDeVista(v: VistaSemanas): string {
  return sumarDias(v.ini, 7 * (SEMANAS_DE_CONTEXTO + 2) + 3).slice(0, 7);
}

/** "Agosto 2026" si la vista son justo las semanas de ese mes con su contexto; si no, el rango ("25 jul a 25 sep"). */
export function etiquetaVista(v: VistaSemanas, hoy?: string): string {
  const mes = mesDeVista(v);
  const delMes = vistaDeMes(mes, hoy);
  return delMes.ini === v.ini && delMes.n === v.n ? etiquetaMes(mes) : rangoCorto(v.ini, finDeVista(v));
}

/** Mover la vista `semanas` semanas (negativo: hacia atrás). */
export function desplazarVista(v: VistaSemanas, semanas: number): VistaSemanas {
  return { ini: sumarDias(v.ini, 7 * semanas), n: v.n };
}

/**
 * La vista a la que hay que ir para ver un pago, o `null` si el pago ya toca las semanas en pantalla. El pago queda
 * en la semana central.
 */
export function vistaParaPago(pago: { ini: string | null; fin: string | null }, v: VistaSemanas): VistaSemanas | null {
  if (!pago.ini || !pago.fin) return null;
  if (pago.ini <= finDeVista(v) && pago.fin >= v.ini) return null;
  const base = pago.fin < v.ini ? pago.fin : pago.ini;
  return { ini: sumarDias(sabadoDeSemana(base), -7 * Math.floor(v.n / 2)), n: v.n };
}

/** El mes `AAAA-MM` anterior. */
export function mesAnterior(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
}

/** ¿Hay algún pago con ventana en el mes? Sin ninguno (solo pagos sin ventana) el mes aún no tiene nada que conciliar. */
export function tienePagosConVentana(respuesta: Pick<CortesMesResponse, "filas">): boolean {
  return respuesta.filas.some((f) => f.pagos.some((p) => p.estado !== "sinv"));
}

/** Meses disponibles, del más reciente al más antiguo, entre dos fechas ISO. */
export function mesesDisponibles(desde: string, hasta: string): string[] {
  const salida: string[] = [];
  let [a, m] = hasta.slice(0, 7).split("-").map(Number);
  const [a0, m0] = desde.slice(0, 7).split("-").map(Number);
  while (a > a0 || (a === a0 && m >= m0)) {
    salida.push(`${a}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      a -= 1;
    }
  }
  return salida;
}

const MESES_LARGOS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

export function etiquetaMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return `${MESES_LARGOS[m - 1]} ${a}`;
}

// ─── Mover un corte (vista previa local) ─────────────────────────────────

function sumaDias(dias: Map<string, number>, ini: string, fin: string): number {
  let total = 0;
  for (let d = ini; d <= fin; d = sumarDias(d, 1)) total += dias.get(d) ?? 0;
  return total;
}

/** Fechas entre las que puede quedar el corte de un pago con el siguiente (último día del pago de la izquierda). */
export function limitesDeCorte(fila: CortesFila, izqId: string): { min: string; max: string } | null {
  const corte = fila.cortes.find((c) => c.izq === izqId);
  const izq = fila.pagos.find((p) => p.pago_id === izqId);
  const der = corte ? fila.pagos.find((p) => p.pago_id === corte.der) : undefined;
  if (!corte || !izq?.ini || !der?.fin) return null;
  return { min: izq.ini, max: sumarDias(der.fin, -1) };
}

/**
 * La fila con el corte de `izqId` en `fecha`, recalculando al momento los dos pagos que toca con los
 * cobros diarios ya cargados. Es solo una vista previa mientras la persona mueve el corte: lo que
 * manda es lo que devuelve el servidor al guardar. Sin sugerencia (aún no se evaluó) y con "cuadra"
 * o "sin explicación" según la diferencia.
 */
export function moverCorteLocal(fila: CortesFila, dias: Map<string, number>, izqId: string, fecha: string): CortesFila {
  const corte = fila.cortes.find((c) => c.izq === izqId);
  if (!corte) return fila;
  const recalcula = (p: CortesPago, ini: string, fin: string): CortesPago => {
    // los días sueltos asignados (cierre de mes) siguen sumándose al mover un corte
    const asignados = (p.dias_asignados ?? []).reduce((t, d) => t + (dias.get(d) ?? 0), 0);
    const calculado = Math.round((sumaDias(dias, ini, fin) + asignados) * 100) / 100;
    const diferencia = Math.round((calculado - p.pagado) * 100) / 100;
    return {
      ...p,
      ini,
      fin,
      calculado,
      diferencia,
      sin_calculo: calculado === 0,
      estado: Math.abs(diferencia) <= 1 ? "ok" : "sin",
      sugerencia: null,
      ajustado: true
    };
  };
  return {
    ...fila,
    pagos: fila.pagos.map((p) => {
      if (p.pago_id === corte.izq && p.ini) return recalcula(p, p.ini, fecha);
      if (p.pago_id === corte.der && p.fin) return recalcula(p, sumarDias(fecha, 1), p.fin);
      return p;
    }),
    cortes: fila.cortes.map((c) => (c.izq === izqId ? { ...c, fecha } : c))
  };
}
