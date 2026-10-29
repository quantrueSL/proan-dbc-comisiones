"use client";

// Panel de un pago: línea de tiempo con los cortes, sugerencia o advertencia y,
// aparte, el detalle por producto de su ventana. Quien tiene permiso puede mover
// un corte con las flechas (los clics seguidos se juntan en un solo guardado),
// aplicar o descartar la sugerencia y devolver el pago a su ventana estándar.
// Arriba: cifras del pago y navegación entre pagos (anterior, siguiente, siguiente
// pendiente). Consolidar congela el pago y sus dos cortes; reabrirlo pide confirmar,
// porque cambia lo que ya se reportó. A un pago sin ventana se le fija a mano.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CortesAccion,
  CortesDetalleResponse,
  CortesLineasPagoResponse,
  CortesEvento,
  CortesExportPagoResponse,
  CortesFila,
  CortesFilaResponse,
  CortesHistorialResponse,
  CortesPago
} from "@/types/comisiones";
import {
  ETIQUETA_ESTADO,
  calculadoPorParte,
  cortesMovidos,
  describirCierre,
  describirSkus,
  describirMovimiento,
  diasQueCambian,
  elementosDeLinea,
  etiquetaMes,
  fechaConDia,
  fechaCorta,
  limitesDeCorte,
  limitesDeFin,
  moverCorteLocal,
  nombreComisionista,
  pagosEnVista,
  pagosOrdenados,
  pesos,
  rangoCorto,
  sumarDias,
  textoDiferencia
} from "./cortes-logica";

type Props = {
  mes: string;
  filaResumen: CortesFila;
  /** "Huevo" o "Huevo + Abarrotes" cuando el pago cubre varias divisiones. */
  etiquetaDivision: string;
  nombresDivision: Record<string, string>;
  pagoId: string;
  puedeEditar: boolean;
  /** Aviso de lo último que se hizo ("Sugerencia aplicada."), que sobrevive al cambio de pago. */
  aviso: string | null;
  saltarSolo: boolean;
  onSaltarSoloChange: (valor: boolean) => void;
  onSiguientePendiente: () => void;
  /** Ir a otro pago de la misma fila, aunque sea de otro mes: la lista cambia de mes si hace falta. */
  onElegirPago: (pago: CortesPago) => void;
  onCerrar: () => void;
  /** La fila ya guardada: la lista del mes se actualiza con ella. */
  onFilaActualizada: (fila: CortesFila) => void;
  /** Se aplicó una sugerencia: la lista decide si se queda aquí o salta al siguiente pendiente. */
  onAccionHecha: (mensaje: string, fila: CortesFila, avanzar?: boolean) => void;
};

const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const PAUSA_PARA_GUARDAR_MS = 700;

async function pedir<T>(ruta: string, cuerpo: unknown): Promise<T> {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo)
  });
  const payload = (await res.json().catch(() => null)) as (T & { detail?: string }) | null;
  if (!res.ok || !payload) throw new Error(payload?.detail || "No se pudo cargar el pago.");
  return payload;
}

function Pastilla({ estado }: { estado: CortesPago["estado"] }) {
  return <span className={`cortes-pastilla is-${estado}`}>{ETIQUETA_ESTADO[estado]}</span>;
}

function Cifras({ pago }: { pago: CortesPago }) {
  const dif = pago.diferencia;
  const cuadra = dif !== null && Math.abs(dif) <= 1;
  return (
    <dl className="cortes-cifras">
      <div>
        <dt>Pagado</dt>
        <dd>{pesos(pago.pagado)}</dd>
      </div>
      <div>
        <dt>Calculado</dt>
        <dd>{pago.calculado === null ? "—" : pesos(pago.calculado)}</dd>
      </div>
      <div>
        <dt>Diferencia</dt>
        <dd className={dif === null ? "" : cuadra ? "is-cuadra" : "is-dif"}>{textoDiferencia(dif)}</dd>
      </div>
    </dl>
  );
}

function DetalleTabla({
  detalle,
  nombresDivision,
  principal
}: {
  detalle: CortesDetalleResponse;
  nombresDivision: Record<string, string>;
  /** La división de la fila: va primero, y las que se pagan junto con ella después. */
  principal: string | null;
}) {
  const divisiones = Array.from(new Set(detalle.filas.map((f) => f.division_code ?? "")));
  const varias = divisiones.length > 1;
  const peso = (c: string | null | undefined) => (c === principal ? "" : `~${c ?? ""}`);
  const orden = [...detalle.filas].sort((a, b) => peso(a.division_code).localeCompare(peso(b.division_code)));
  const nombre = (codigo: string | null | undefined) => (codigo ? nombresDivision[codigo] ?? codigo : "—");
  const columnas = varias ? 8 : 7;
  return (
    <div className="hydro-table-wrap">
      <table className="cortes-tabla">
        <thead>
          <tr>
            {varias ? <th>División</th> : null}
            <th>CEDIS</th>
            <th>Producto</th>
            <th className="n">Vendido</th>
            <th>Unidad tarifa</th>
            <th className="n">Cant. base</th>
            <th className="n">Tarifa</th>
            <th className="n">Comisión</th>
          </tr>
        </thead>
        <tbody>
          {orden.map((f, i) => {
            const cambioDivision = varias && i > 0 && orden[i - 1].division_code !== f.division_code;
            const subtotal = cambioDivision
              ? orden.filter((o) => o.division_code === orden[i - 1].division_code).reduce((t, o) => t + (o.comision_total ?? 0), 0)
              : null;
            return (
              <Fragment key={`${f.division_code}-${f.cedis}-${f.oficina}-${f.tipo_venta}-${f.matnr}-${i}`}>
                {subtotal !== null ? (
                  <tr className="cortes-subtotal">
                    <td colSpan={columnas - 1}>Subtotal {nombre(orden[i - 1].division_code)}</td>
                    <td className="n">{pesos(subtotal)}</td>
                  </tr>
                ) : null}
                <tr>
                  {varias ? <td>{nombre(f.division_code)}</td> : null}
                  <td>
                    {f.cedis ?? "—"}
                    {f.tipo_venta ? <small> · {f.tipo_venta}</small> : null}
                  </td>
                  <td title={f.matnr}>{f.descripcion ?? f.matnr}</td>
                  <td className="n">
                    {f.cantidad_venta_total === null ? "—" : numero.format(f.cantidad_venta_total)} <small>{f.unidad_venta}</small>
                  </td>
                  <td>{f.unidad_tarifa ?? "—"}</td>
                  <td className="n">{f.cantidad_base_total === null ? "—" : numero.format(f.cantidad_base_total)}</td>
                  <td className="n">{f.tarifa === null ? "—" : numero.format(f.tarifa)}</td>
                  <td className="n">{pesos(f.comision_total)}</td>
                </tr>
              </Fragment>
            );
          })}
          {varias && orden.length ? (
            <tr className="cortes-subtotal">
              <td colSpan={columnas - 1}>Subtotal {nombre(orden[orden.length - 1].division_code)}</td>
              <td className="n">
                {pesos(orden.filter((o) => o.division_code === orden[orden.length - 1].division_code).reduce((t, o) => t + (o.comision_total ?? 0), 0))}
              </td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={columnas - 1}>Total</td>
            <td className="n">{pesos(detalle.comision_total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Resumen({ pago }: { pago: CortesPago }) {
  const dif = pago.diferencia;
  const cuadra = dif !== null && Math.abs(dif) <= 1;
  return (
    <dl className="cortes-resumen">
      <div>
        <dt>Pagado</dt>
        <dd>{pesos(pago.pagado)}</dd>
      </div>
      <div>
        <dt>Calculado</dt>
        <dd>{pago.calculado === null ? "—" : pesos(pago.calculado)}</dd>
      </div>
      <div>
        <dt>Diferencia</dt>
        <dd className={dif === null ? "" : cuadra ? "is-cuadra" : "is-dif"}>{textoDiferencia(dif)}</dd>
      </div>
    </dl>
  );
}

const formatoMomento = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Mexico_City"
});

function describirEvento(e: CortesEvento): string {
  const fecha = e.detalle?.fecha ? fechaConDia(e.detalle.fecha) : "";
  switch (e.tipo) {
    case "mover_corte":
      return `movió un corte al ${fecha}`;
    case "mover_borde":
      return `movió el ${e.detalle?.borde === "ini" ? "inicio" : "fin"} de un pago al ${fecha}`;
    case "aplicar_sugerencia":
      return "aplicó la sugerencia";
    case "descartar_sugerencia":
      return "descartó la sugerencia";
    case "recuperar_sugerencia":
      return "recuperó la sugerencia";
    case "restablecer_pago":
      return "devolvió un pago a su ventana estándar";
    case "consolidar":
      return "consolidó el pago";
    case "consolidar_lote":
      return "consolidó el pago en lote";
    case "reabrir":
      return "reabrió el pago consolidado";
    case "fijar_ventana":
      return `fijó la ventana del pago del ${e.detalle?.ini ? fechaConDia(e.detalle.ini) : ""} al ${e.detalle?.fin ? fechaConDia(e.detalle.fin) : ""}`;
    case "comentar":
      return `comentó: “${e.detalle?.texto ?? ""}”`;
    case "borrar_comentario":
      return "borró un comentario";
    case "mover_skus": {
      const semanas = (e.detalle?.bloques ?? "").split(",").filter(Boolean).map(fechaCorta).join(", ");
      return e.detalle?.destino
        ? `movió a este pago los 4 SKUs de las semanas del ${semanas}`
        : `dejó sin pagar los 4 SKUs de las semanas del ${semanas}`;
    }
    case "asignar_dias":
      return e.detalle?.dias ? `asignó los días de cierre ${e.detalle.dias.split(",").map(fechaCorta).join(", ")}` : "quitó los días de cierre asignados";
    default:
      return e.tipo;
  }
}

export function CortesPanel({
  mes,
  filaResumen,
  etiquetaDivision,
  nombresDivision,
  pagoId,
  puedeEditar,
  aviso: avisoAccion,
  saltarSolo,
  onSaltarSoloChange,
  onSiguientePendiente,
  onElegirPago,
  onCerrar,
  onFilaActualizada,
  onAccionHecha
}: Props) {
  const [tab, setTab] = useState<"cortes" | "detalle">("cortes");
  const [contexto, setContexto] = useState(1);
  const [datos, setDatos] = useState<CortesFilaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<CortesDetalleResponse | null>(null);
  const [lineasPago, setLineasPago] = useState<CortesLineasPagoResponse | null>(null);
  const [detalleError, setDetalleError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<{ izqId: string; fecha: string } | null>(null);
  const [historial, setHistorial] = useState<CortesEvento[] | null>(null);
  // Pagos consolidados que la persona quiere reabrir: se pide confirmar antes.
  const [reabrir, setReabrir] = useState<string[] | null>(null);
  const [ventana, setVentana] = useState({ ini: "", fin: "" });
  const [exportando, setExportando] = useState(false);
  const [comentario, setComentario] = useState("");
  // Días de cierre de mes que la persona marcó para incluirlos en este pago.
  const [diasElegidos, setDiasElegidos] = useState<string[]>([]);
  const [skusElegidos, setSkusElegidos] = useState<string[]>([]);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ultimaFecha = useRef<{ izqId: string; fecha: string } | null>(null);

  const cargarFila = useCallback(async () => {
    const r = await pedir<CortesFilaResponse>("/api/comisionesbi/cortes/fila", {
      mes,
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code
    });
    setDatos(r);
    return r;
  }, [mes, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  // Cambió el pago: se vuelve a la pestaña de cortes y se vuelve a pedir la fila.
  useEffect(() => {
    let vigente = true;
    setTab("cortes");
    setDatos(null);
    setDetalle(null);
    setError(null);
    setDetalleError(null);
    setAviso(null);
    setPendiente(null);
    setHistorial(null);
    setReabrir(null);
    setVentana({ ini: "", fin: "" });
    setDiasElegidos([]);
    setComentario("");
    cargarFila().catch((e) => vigente && setError(e instanceof Error ? e.message : "No se pudo cargar el pago."));
    return () => {
      vigente = false;
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, [cargarFila, filaResumen.fila_id, pagoId]);

  const filaBase = datos?.fila ?? null;
  const dias = useMemo(() => new Map(datos?.dias ?? []), [datos]);
  // Mientras hay un corte sin guardar se dibuja con la vista previa local.
  const fila = useMemo(
    () => (filaBase && pendiente ? moverCorteLocal(filaBase, dias, pendiente.izqId, pendiente.fecha) : filaBase),
    [filaBase, dias, pendiente]
  );
  const pago = (fila ?? filaResumen).pagos.find((p) => p.pago_id === pagoId) ?? null;

  // Botana: lo pagado por línea del pedido contra lo calculado por familia; se vuelve a pedir si cambia lo que el pago incluye.
  const lineasKey =
    pago?.ini && pago.fin && filaResumen.division_code === "BO"
      ? JSON.stringify([pago.pago_id, pago.ini, pago.fin, pago.dias_asignados ?? [], (pago.skus_incluidos ?? []).map((b) => b.ini)])
      : null;
  useEffect(() => {
    setLineasPago(null);
    if (!lineasKey || !pago?.ini || !pago.fin) return;
    let vigente = true;
    pedir<CortesLineasPagoResponse>("/api/comisionesbi/cortes/editar/lineas", {
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code,
      docs: pago.docs,
      ini: pago.ini,
      fin: pago.fin,
      dias: pago.dias_asignados ?? [],
      skus: (pago.skus_incluidos ?? []).map(({ ini, fin }) => ({ ini, fin }))
    })
      .then((r) => vigente && setLineasPago(r))
      .catch(() => vigente && setLineasPago(null));
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineasKey]);

  // El detalle por producto se pide solo al abrir su pestaña (y otra vez si la ventana cambió).
  const ventanaKey = pago?.ini && pago.fin ? `${pago.ini}|${pago.fin}` : null;
  useEffect(() => {
    setDetalle(null);
    setDetalleError(null);
  }, [ventanaKey]);
  useEffect(() => {
    if (tab !== "detalle" || !ventanaKey || detalle || pendiente) return;
    const [ini, fin] = ventanaKey.split("|");
    let vigente = true;
    pedir<CortesDetalleResponse>("/api/comisionesbi/cortes/detalle", {
      sociedad: filaResumen.sociedad,
      comisionista_id: filaResumen.comisionista_id,
      division_code: filaResumen.division_code,
      ini,
      fin
    })
      .then((r) => vigente && setDetalle(r))
      .catch((e) => vigente && setDetalleError(e instanceof Error ? e.message : "No se pudo cargar el detalle."));
    return () => {
      vigente = false;
    };
  }, [tab, ventanaKey, detalle, pendiente, filaResumen.sociedad, filaResumen.comisionista_id, filaResumen.division_code]);

  async function editar(accion: CortesAccion, extra: Record<string, unknown>, mensajeExito?: string, avanzar = true): Promise<boolean> {
    if (!filaBase) return false;
    setGuardando(true);
    setAviso(null);
    try {
      const res = await fetch(`/api/comisionesbi/cortes/editar/${accion}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mes,
          sociedad: filaResumen.sociedad,
          comisionista_id: filaResumen.comisionista_id,
          division_code: filaResumen.division_code,
          version: filaBase.version,
          ...extra
        })
      });
      const payload = (await res.json().catch(() => null)) as (CortesFilaResponse & { detail?: string; codigo?: string }) | null;
      if (res.ok && payload?.fila) {
        setDatos(payload);
        setHistorial(null);
        setDiasElegidos([]);
        setSkusElegidos([]);
        onFilaActualizada(payload.fila);
        if (mensajeExito) onAccionHecha(mensajeExito, payload.fila, avanzar);
        return true;
      }
      if (res.status === 409 && payload?.codigo === "conflicto_version") {
        setAviso("Otra persona cambió esta fila mientras la editabas. Se cargó lo último.");
        const nueva = await cargarFila().catch(() => null);
        if (nueva?.fila) onFilaActualizada(nueva.fila);
      } else {
        setAviso(payload?.detail || "No se pudo guardar el cambio.");
      }
      return false;
    } catch {
      setAviso("No se pudo guardar el cambio. Vuelve a intentarlo en unos instantes.");
      return false;
    } finally {
      setPendiente(null);
      ultimaFecha.current = null;
      setGuardando(false);
    }
  }

  // Un clic mueve el corte un día en la vista previa; cuando pasan 700 ms sin otro clic, se guarda UNA vez.
  function moverCorte(izqId: string, delta: number) {
    if (!filaBase || guardando) return;
    const actual = ultimaFecha.current?.izqId === izqId ? ultimaFecha.current.fecha : filaBase.cortes.find((c) => c.izq === izqId)?.fecha;
    const limites = limitesDeCorte(filaBase, izqId);
    if (!actual || !limites) return;
    const nueva = sumarDias(actual, delta);
    if (nueva < limites.min || nueva > limites.max) return;
    ultimaFecha.current = { izqId, fecha: nueva };
    setPendiente({ izqId, fecha: nueva });
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      const ultima = ultimaFecha.current;
      const guardada = filaBase.cortes.find((c) => c.izq === izqId)?.fecha;
      if (!ultima || ultima.fecha === guardada) {
        ultimaFecha.current = null;
        setPendiente(null);
        return;
      }
      void editar("mover", { izq_pago_id: ultima.izqId, fecha: ultima.fecha });
    }, PAUSA_PARA_GUARDAR_MS);
  }

  // Mover el fin de un pago que no comparte corte con el siguiente (hay días de cierre en medio): los días que suelta quedan libres.
  function moverFin(izqId: string, derId: string, delta: number) {
    if (!filaBase || guardando) return;
    const izq = filaBase.pagos.find((p) => p.pago_id === izqId);
    const limites = limitesDeFin(filaBase, izqId, derId);
    if (!izq?.fin || !limites) return;
    const nueva = sumarDias(izq.fin, delta);
    if (nueva < limites.min || nueva > limites.max) return;
    void editar("mover-borde", { pago_id: izqId, borde: "fin", fecha: nueva }, undefined, false);
  }

  // Flechas del fin del pago de la izquierda, en el hueco o el salto de fin de mes que lo separa del siguiente.
  function flechasFin(el: { izq: string; der: string }) {
    const izq = filaBase?.pagos.find((p) => p.pago_id === el.izq);
    const limites = filaBase ? limitesDeFin(filaBase, el.izq, el.der) : null;
    if (!izq?.fin || !limites) return null;
    const movible = puedeEditar && izq.estado !== "cons";
    return (
      <div className="cortes-corte is-salto">
        <span>Fin del pago anterior</span>
        <b>{fechaConDia(izq.fin)}</b>
        {movible ? (
          <span className="cortes-corte-flechas">
            <button
              aria-label="Mover el fin del pago un día antes"
              disabled={guardando || izq.fin <= limites.min}
              onClick={() => moverFin(el.izq, el.der, -1)}
              title="Suelta ese día: queda libre para sumarlo al pago siguiente"
              type="button"
            >
              ◀
            </button>
            <button
              aria-label="Mover el fin del pago un día después"
              disabled={guardando || izq.fin >= limites.max}
              onClick={() => moverFin(el.izq, el.der, 1)}
              type="button"
            >
              ▶
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  // Excel del pago: lo de la pestaña de Conciliación (por producto, por día y por línea de factura) de su ventana.
  async function descargarExcel() {
    if (!pago?.ini || !pago.fin) return;
    setExportando(true);
    setAviso(null);
    try {
      const datos = await pedir<CortesExportPagoResponse>("/api/comisionesbi/cortes/editar/exportar", {
        sociedad: filaResumen.sociedad,
        comisionista_id: filaResumen.comisionista_id,
        division_code: filaResumen.division_code,
        ini: pago.ini,
        fin: pago.fin,
        dias: pago.dias_asignados ?? [],
        skus: (pago.skus_incluidos ?? []).map(({ ini, fin }) => ({ ini, fin }))
      });
      // Lo que se tocó a mano en este pago, del historial de la fila (de lo más viejo a lo más nuevo).
      const hist = await pedir<CortesHistorialResponse>("/api/comisionesbi/cortes/editar/historial", {
        sociedad: filaResumen.sociedad,
        comisionista_id: filaResumen.comisionista_id,
        division_code: filaResumen.division_code,
        limite: 100
      }).catch(() => ({ eventos: [] as CortesEvento[] }));
      const modificaciones = hist.eventos
        .filter((e) => e.pago_id === pago.pago_id || !!e.antes?.[pago.pago_id] || !!e.despues?.[pago.pago_id] || (e.detalle?.pagos ?? "").split(",").includes(pago.pago_id) || (e.detalle?.origen ?? "").split(",").includes(pago.pago_id))
        .reverse()
        .map((e) => ({
          cuando: e.ts ? formatoMomento.format(new Date(e.ts)) : "—",
          quien: e.usuario ?? "—",
          que: describirEvento(e)
        }));
      const { construirExcelPago, descargarBlob } = await import("./cortes-excel");
      const blob = await construirExcelPago(datos, {
        comisionista: nombreComisionista(filaResumen),
        division: etiquetaDivision,
        pago,
        modificaciones
      });
      const nombre = nombreComisionista(filaResumen).replace(/\s+/g, "_");
      descargarBlob(`conciliacion_${nombre}_${filaResumen.division_code ?? "sd"}_${pago.ini}_${pago.fin}.xlsx`, blob);
    } catch (causa) {
      setAviso(causa instanceof Error ? causa.message : "No se pudo preparar el Excel.");
    } finally {
      setExportando(false);
    }
  }

  async function abrirHistorial(abierto: boolean) {
    if (!abierto || historial) return;
    try {
      const r = await pedir<CortesHistorialResponse>("/api/comisionesbi/cortes/editar/historial", {
        sociedad: filaResumen.sociedad,
        comisionista_id: filaResumen.comisionista_id,
        division_code: filaResumen.division_code,
        limite: 20
      });
      setHistorial(r.eventos);
    } catch {
      setHistorial([]);
    }
  }

  if (!pago) return null;
  const sinVentana = pago.ini === null || pago.fin === null;
  const sugerencia = pago.estado === "sug" && !pendiente ? pago.sugerencia : null;
  const marcados = diasQueCambian(sugerencia);
  const vista = fila && !sinVentana ? pagosEnVista(fila, pago.pago_id, contexto) : [];
  const elementos = fila ? elementosDeLinea(fila, vista) : [];
  const puedeActuar = puedeEditar && !guardando && !pendiente && !!filaBase;
  const filaActual = fila ?? filaResumen;
  // Anterior y siguiente salen de toda la fila cargada (con margen de un mes a cada lado), no solo del mes en pantalla.
  const ordenados = fila ? pagosOrdenados(fila) : [];
  const posicion = ordenados.findIndex((p) => p.pago_id === pago.pago_id);
  const anterior = posicion > 0 ? ordenados[posicion - 1] : null;
  const siguiente = posicion >= 0 && posicion < ordenados.length - 1 ? ordenados[posicion + 1] : null;
  const huerfanos = filaActual.huerfanos ?? [];
  const consolidado = pago.estado === "cons";
  // Cierre de mes a mano: los días libres de los huecos de cierre y los que este pago ya tiene asignados.
  const huecosCierre = puedeEditar && !consolidado && !sinVentana ? filaActual.huecos.filter((h) => h.cierre) : [];
  // Huecos de cierre ordenados por cercanía al pago: el del mes que se está viendo queda primero.
  const diasDeDistancia = (h: { ini: string; fin: string }) => {
    const ref = pago.ini ?? h.ini;
    const dif = h.fin < ref ? Date.parse(ref) - Date.parse(h.fin) : Date.parse(h.ini) - Date.parse(pago.fin ?? ref);
    return Math.max(0, Math.round(dif / 86400000));
  };
  const huecosCierreOrdenados = [...huecosCierre].sort((a, b) => diasDeDistancia(a) - diasDeDistancia(b));
  const diasPropios = pago.dias_asignados ?? [];
  const asignadosAOtros = new Set(filaActual.pagos.filter((p) => p.pago_id !== pago.pago_id).flatMap((p) => p.dias_asignados ?? []));
  const semanasSkus = filaActual.skus ?? [];
  const sumaSkusElegida = semanasSkus.filter((b) => skusElegidos.includes(b.ini)).reduce((t, b) => t + b.comision, 0);
  const sumaElegida = diasElegidos.reduce((t, d) => t + (dias.get(d) ?? 0), 0);
  const alternarDia = (d: string) => setDiasElegidos((previos) => (previos.includes(d) ? previos.filter((x) => x !== d) : [...previos, d].sort()));
  /** Los pagos consolidados a cada lado de un corte (uno o los dos). */
  function consolidadosDelCorte(izqId: string): string[] {
    const corte = filaActual.cortes.find((c) => c.izq === izqId);
    return [corte?.izq, corte?.der].filter((id): id is string => !!id && filaActual.pagos.find((p) => p.pago_id === id)?.estado === "cons");
  }
  // Desglose por división cuando el pago junta varias (Huevo + Abarrotes).
  const partes =
    !sinVentana && datos?.dias_partes && Object.keys(datos.dias_partes).length > 1
      ? Object.entries(calculadoPorParte(datos.dias_partes, pago.ini!, pago.fin!)).sort(([a], [b]) =>
          a === filaResumen.division_code ? -1 : b === filaResumen.division_code ? 1 : a.localeCompare(b)
        )
      : null;

  return (
    <section aria-label="Panel del pago" className="cortes-panel">
      <header className="cortes-panel-cab">
        <div>
          <h2>
            {nombreComisionista(filaResumen)} · {etiquetaDivision}
          </h2>
          <p>
            {filaResumen.sociedad} ·{" "}
            {sinVentana ? "pago sin ventana" : `pago ${rangoCorto(pago.ini!, pago.fin!)}`}
          </p>
          {pago.documentos?.map((d) => (
            <p className="cortes-panel-doc" key={d.doc_id}>
              <span>
                Doc. {d.documento}
                {d.compensacion ? ` · Pago SAP ${d.compensacion}` : ""}
                {d.fecha_pago ? ` · pagado el ${fechaCorta(d.fecha_pago)}` : ""}
              </span>
              {d.texto ? <b>{d.texto}</b> : null}
            </p>
          ))}
        </div>
        <div className="cortes-panel-cab-acc">
          {pendiente ? <span className="cortes-estado-guardado">Cambio sin guardar…</span> : null}
          {guardando ? <span className="cortes-estado-guardado">Guardando…</span> : null}
          <Pastilla estado={pago.estado} />
          <button aria-label="Cerrar el panel" className="cortes-cerrar" onClick={onCerrar} type="button">
            ×
          </button>
        </div>
      </header>

      <nav aria-label="Moverse entre pagos" className="cortes-nav">
        <button className="cortes-boton" disabled={!anterior} onClick={() => anterior && onElegirPago(anterior)} type="button">
          ‹ Pago anterior
        </button>
        <button className="cortes-boton" disabled={!siguiente} onClick={() => siguiente && onElegirPago(siguiente)} type="button">
          Pago siguiente ›
        </button>
        <button className="cortes-boton is-primario" onClick={onSiguientePendiente} title="Atajo: N" type="button">
          Siguiente pendiente ›
        </button>
        <label className="cortes-check">
          <input checked={saltarSolo} onChange={(e) => onSaltarSoloChange(e.target.checked)} type="checkbox" />
          Pasar solo al siguiente pendiente
        </label>
      </nav>

      {avisoAccion ? (
        <p className="cortes-flash" role="status">
          ✓ {avisoAccion}
        </p>
      ) : null}

      <Resumen pago={pago} />

      {partes ? (
        <div className="cortes-bloque cortes-partes">
          <p className="cortes-nota">
            Un solo pago de SAP cubre {etiquetaDivision}. Se compara con la suma de las comisiones y los cortes se mueven en bloque.
          </p>
          <div className="hydro-table-wrap">
            <table className="cortes-tabla cortes-tabla-partes">
              <thead>
                <tr>
                  <th>Origen</th>
                  <th className="n">Comisión</th>
                </tr>
              </thead>
              <tbody>
                {partes.map(([origen, monto]) => (
                  <tr key={origen}>
                    <td>Calculado · {nombresDivision[origen] ?? origen}</td>
                    <td className="n">{pesos(monto)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Suma calculada</td>
                  <td className="n">{pago.calculado === null ? "—" : pesos(pago.calculado)}</td>
                </tr>
                <tr>
                  <td>Pagado (un solo pago)</td>
                  <td className="n">{pesos(pago.pagado)}</td>
                </tr>
                <tr>
                  <td>Diferencia</td>
                  <td className={`n ${pago.diferencia !== null && Math.abs(pago.diferencia) <= 1 ? "is-cuadra" : "is-dif"}`}>
                    {textoDiferencia(pago.diferencia)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}

      {huerfanos.length ? (
        <div className="cortes-caja is-aviso cortes-huerfanos">
          <h3>Guardado de un documento que ya no está en SAP</h3>
          <ul>
            {huerfanos.map((h) => (
              <li key={h.pago_id}>
                <span>
                  {h.tipo === "consolidado" ? "Consolidado" : "Ajuste"} {h.ini && h.fin ? rangoCorto(h.ini, h.fin) : ""} · {h.pago_id.split("|").pop()}
                </span>
                {puedeEditar ? (
                  <button
                    className="cortes-boton"
                    disabled={!puedeActuar}
                    onClick={() => void editar("quitar-huerfano", { pago_id: h.pago_id }, "Se quitó lo guardado de ese documento.", false)}
                    type="button"
                  >
                    Quitar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p>Mientras siga ahí, esos cobros pueden quedar sin pago. Quítalo si el documento se canceló o se volvió a cargar.</p>
        </div>
      ) : null}

      {reabrir ? (
        <div className="cortes-caja is-error cortes-reabrir" role="alertdialog">
          <h3>Esto ya estaba cerrado</h3>
          <p>
            {reabrir
              .map((id) => {
                const p = filaActual.pagos.find((x) => x.pago_id === id);
                return p?.ini && p.fin
                  ? `${rangoCorto(p.ini, p.fin)}${p.consolidado_por ? `, consolidado por ${p.consolidado_por}` : ""}`
                  : id;
              })
              .join(" · ")}
            . Reabrirlo permite mover sus cortes y cambia lo que ya se reportó.
          </p>
          <div className="cortes-acciones">
            <button
              className="cortes-boton is-peligro"
              disabled={!puedeActuar}
              onClick={() => void editar("reabrir", { pago_ids: reabrir }, reabrir.length > 1 ? "Pagos reabiertos." : "Pago reabierto.", false).then(() => setReabrir(null))}
              type="button"
            >
              Reabrir {reabrir.length} pago(s)
            </button>
            <button className="cortes-boton" onClick={() => setReabrir(null)} type="button">
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      <div className="cortes-tabs" role="tablist">
        <button aria-selected={tab === "cortes"} onClick={() => setTab("cortes")} role="tab" type="button">
          Cortes
        </button>
        <button aria-selected={tab === "detalle"} disabled={sinVentana} onClick={() => setTab("detalle")} role="tab" type="button">
          Detalle por producto
        </button>
        <button
          className="cortes-excel"
          disabled={sinVentana || exportando}
          onClick={() => void descargarExcel()}
          title="Excel de este pago: por producto, por día y por línea de factura"
          type="button"
        >
          {exportando ? "Preparando Excel…" : "Descargar Excel"}
        </button>
      </div>

      {aviso ? (
        <p className="cortes-aviso" role="alert">
          {aviso}
        </p>
      ) : null}

      {tab === "detalle" ? (
        <div className="cortes-bloque">
          {detalleError ? <p className="hydro-error">{detalleError}</p> : null}
          {!detalle && !detalleError ? <p className="hydro-muted">Cargando el detalle…</p> : null}
          {detalle ? (
            <>
              <p className="cortes-nota">
                Productos cobrados entre {fechaCorta(detalle.ini)} y {fechaCorta(detalle.fin)}, la ventana de este pago.
                Si se mueve un corte, esta tabla cambia con él.
              </p>
              <DetalleTabla detalle={detalle} nombresDivision={nombresDivision} principal={filaResumen.division_code} />
            </>
          ) : null}
        </div>
      ) : (
        <>
          {error ? <p className="hydro-error">{error}</p> : null}

          {sinVentana ? (
            <div className="cortes-bloque">
              <Cifras pago={pago} />
              <div className="cortes-caja is-aviso">
                <h3>Pago sin ventana</h3>
                <p>
                  El texto de este pago no trae fechas que se puedan leer, así que no sabemos qué cobros cubre. Pagado{" "}
                  {pesos(pago.pagado)}, documento {pago.docs.join(", ")}.{" "}
                  {puedeEditar ? "Dale su inicio y su fin para ver contra qué cobros se compara." : ""}
                </p>
                {puedeEditar ? (
                  <div className="cortes-ventana">
                    <label>
                      Inicio
                      <input onChange={(e) => setVentana((v) => ({ ...v, ini: e.target.value }))} type="date" value={ventana.ini} />
                    </label>
                    <label>
                      Fin
                      <input onChange={(e) => setVentana((v) => ({ ...v, fin: e.target.value }))} type="date" value={ventana.fin} />
                    </label>
                    <button
                      className="cortes-boton is-primario"
                      disabled={!puedeActuar || !ventana.ini || !ventana.fin || ventana.ini > ventana.fin}
                      onClick={() => void editar("fijar-ventana", { pago_id: pago.pago_id, ini: ventana.ini, fin: ventana.fin }, "Ventana fijada.", false)}
                      type="button"
                    >
                      Fijar ventana
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <div className="cortes-bloque">
                {!datos && !error ? <p className="hydro-muted">Cargando la línea de tiempo…</p> : null}
                {fila ? (
                  <>
                    <div className="cortes-linea-scroll">
                      <div className="cortes-linea">
                        {elementos.map((el, i) => {
                          if (el.tipo === "corte") {
                            const movible = puedeEditar && !el.congelado;
                            const limites = filaBase ? limitesDeCorte(filaBase, el.izq) : null;
                            return (
                              <div className={`cortes-corte${el.congelado ? " is-congelado" : ""}`} key={`c${i}`}>
                                <span>Corte</span>
                                <b>{fechaConDia(el.fecha)}</b>
                                {el.congelado ? <small>Congelado</small> : null}
                                {el.congelado && puedeEditar ? (
                                  <button
                                    className="cortes-ir"
                                    onClick={() => setReabrir(consolidadosDelCorte(el.izq))}
                                    title="Para moverlo hay que reabrir el pago consolidado"
                                    type="button"
                                  >
                                    Reabrir
                                  </button>
                                ) : null}
                                {movible ? (
                                  <span className="cortes-corte-flechas">
                                    <button
                                      aria-label="Mover el corte un día antes"
                                      disabled={guardando || !limites || el.fecha <= limites.min}
                                      onClick={() => moverCorte(el.izq, -1)}
                                      type="button"
                                    >
                                      ◀
                                    </button>
                                    <button
                                      aria-label="Mover el corte un día después"
                                      disabled={guardando || !limites || el.fecha >= limites.max}
                                      onClick={() => moverCorte(el.izq, 1)}
                                      type="button"
                                    >
                                      ▶
                                    </button>
                                  </span>
                                ) : null}
                                {sugerencia?.cambios.some((c) => c.borde === "fin" && c.pago_id === el.izq) ? (
                                  <small className="cortes-sugerido">
                                    Sugerido: {fechaConDia(sugerencia.cambios.find((c) => c.borde === "fin" && c.pago_id === el.izq)!.a)}
                                  </small>
                                ) : null}
                              </div>
                            );
                          }
                          if (el.tipo === "salto") {
                            return <Fragment key={`s${i}`}>{flechasFin(el)}</Fragment>;
                          }
                          if (el.tipo === "traslape") {
                            return (
                              <div className="cortes-corte is-traslape" key={`t${i}`}>
                                <span>Traslape</span>
                                <b>{rangoCorto(el.ini, el.fin)}</b>
                                <small>Días en dos pagos</small>
                              </div>
                            );
                          }
                          if (el.tipo === "hueco") {
                            const dd: string[] = [];
                            for (let d = el.ini; d <= el.fin; d = sumarDias(d, 1)) dd.push(d);
                            return (
                              <div className={`cortes-tramo is-hueco${el.cierre ? " is-cierre" : ""}`} key={`h${i}`}>
                                {flechasFin(el)}
                                <div className="cortes-tramo-cab">
                                  <b>{el.cierre ? "Cierre de mes" : "Sin pago"}</b>
                                  <span className={`cortes-pastilla ${el.cierre ? "is-cons" : "is-sinv"}`}>
                                    {el.cierre ? "Cierre de mes, sin asignar" : "Comisión calculada sin pago"}
                                  </span>
                                </div>
                                <dl className="cortes-cifras">
                                  <div>
                                    <dt>Comisión</dt>
                                    <dd>{pesos(el.comision)}</dd>
                                  </div>
                                </dl>
                                <div className="cortes-dias">
                                  {dd.map((d) => (
                                    <div className={`cortes-dia${marcados.has(d) ? " is-mv" : ""}`} key={d}>
                                      <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                      {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          const p = el.pago;
                          const dd: string[] = [];
                          for (let d = p.ini!; d <= p.fin!; d = sumarDias(d, 1)) dd.push(d);
                          const indice = vista.findIndex((v) => v.pago_id === p.pago_id);
                          return (
                            <div
                              className={`cortes-tramo${p.pago_id === pago.pago_id ? " is-actual" : ""}`}
                              key={p.pago_id}
                              title={`Documento ${p.docs.join(", ")}`}
                            >
                              <div className="cortes-tramo-cab">
                                {p.pago_id === pago.pago_id ? (
                                  <b>{rangoCorto(p.ini!, p.fin!)}</b>
                                ) : (
                                  <button className="cortes-ir" onClick={() => onElegirPago(p)} title="Ir a este pago" type="button">
                                    {rangoCorto(p.ini!, p.fin!)}
                                  </button>
                                )}
                                <Pastilla estado={p.estado} />
                              </div>
                              <Cifras pago={p} />
                              <div className="cortes-dias">
                                {/* los días asignados van en su lugar: a la izquierda si son anteriores a la ventana, a la derecha si son posteriores */}
                                {[...(p.dias_asignados ?? []).map((d) => ({ d, asignado: true })), ...dd.map((d) => ({ d, asignado: false }))]
                                  .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0))
                                  .map(({ d, asignado }) =>
                                    asignado ? (
                                      <div className="cortes-dia is-asignado" key={`a${d}`} title="Día de cierre asignado a este pago">
                                        <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                        {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                      </div>
                                    ) : (
                                      <div className={`cortes-dia c${indice % 3}${marcados.has(d) ? " is-mv" : ""}`} key={d}>
                                        <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                        {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                      </div>
                                    )
                                  )}
                              </div>
                              {(p.dias_asignados ?? []).length ? (
                                <small className="cortes-incluye">
                                  Incluye el cierre del{" "}
                                  {(p.dias_asignados ?? []).length > 1
                                    ? rangoCorto(p.dias_asignados![0], p.dias_asignados![p.dias_asignados!.length - 1])
                                    : fechaCorta(p.dias_asignados![0])}
                                  :{" "}
                                  {pesos((p.dias_asignados ?? []).reduce((t, d) => t + (dias.get(d) ?? 0), 0))}
                                </small>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="cortes-acciones">
                      <button className="cortes-boton" onClick={() => setContexto((c) => (c === 1 ? 2 : 1))} type="button">
                        {contexto === 1 ? "Ampliar contexto (±2 pagos)" : "Reducir contexto (±1 pago)"}
                      </button>
                      {pago.ajustado && puedeEditar ? (
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("restablecer", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Volver a la ventana estándar
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>

              {pago.sin_calculo ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-aviso">
                    <h3>Pago sin cálculo</h3>
                    <p>No hay comisión calculada para este comisionista y división en la ventana del pago.</p>
                  </div>
                </div>
              ) : null}

              {sugerencia ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-sugerencia">
                    <div className="cortes-fichas">
                      <span className={`cortes-ficha${sugerencia.unica ? " is-ok" : " is-aviso"}`}>
                        {sugerencia.unica ? "Única opción exacta" : "Varias opciones, la de menor cambio"}
                      </span>
                    </div>
                    <h3>
                      Sugerencia:{" "}
                      {sugerencia.tipo === "cierre"
                        ? describirCierre(sugerencia)
                        : sugerencia.tipo === "skus"
                          ? describirSkus(sugerencia, filaActual.skus ?? [])
                          : cortesMovidos(sugerencia).map(describirMovimiento).join(" y ")}
                    </h3>
                    <div className="cortes-antes-despues">
                      {sugerencia.afectados.map((a) => (
                        <div key={a.pago_id}>
                          <span>{rangoCorto(a.ini_antes, a.fin_antes)}</span>
                          <b>
                            <s>{textoDiferencia(a.diferencia_antes)}</s> → {textoDiferencia(a.diferencia_despues)}
                          </b>
                        </div>
                      ))}
                    </div>
                    {puedeEditar ? (
                      <div className="cortes-acciones">
                        <button
                          className="cortes-boton is-primario"
                          disabled={!puedeActuar}
                          onClick={() =>
                            void editar(
                              "aplicar",
                              {
                                pago_id: pago.pago_id,
                                cambios: sugerencia.cambios,
                                dias: sugerencia.dias_asignar ?? [],
                                bloques: sugerencia.bloques_asignar ?? []
                              },
                              "Sugerencia aplicada."
                            )
                          }
                          type="button"
                        >
                          Aplicar
                        </button>
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("descartar", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Descartar
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {huecosCierre.length || diasPropios.length ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja">
                    <h3>Cierre de mes</h3>
                    {diasPropios.length ? (
                      <p>
                        Este pago incluye el cierre del {diasPropios.map(fechaCorta).join(", ")}:{" "}
                        {pesos(diasPropios.reduce((t, d) => t + (dias.get(d) ?? 0), 0))}.{" "}
                        <button
                          className="cortes-ir"
                          disabled={!puedeActuar}
                          onClick={() => void editar("asignar-dias", { pago_id: pago.pago_id, dias: [] }, "Cierre quitado de este pago.", false)}
                          type="button"
                        >
                          Quitar
                        </button>
                      </p>
                    ) : null}
                    <div className="cortes-cierres">
                      {huecosCierreOrdenados.map((h, i) => {
                        const dd: string[] = [];
                        for (let d = h.ini; d <= h.fin; d = sumarDias(d, 1)) dd.push(d);
                        return (
                          <div className={`cortes-cierre${i === 0 ? " is-cercano" : ""}`} key={h.ini}>
                            <b>Cierre de {etiquetaMes(h.ini.slice(0, 7))}</b>
                            <small>{i === 0 ? "El más cercano a este pago" : `A ${diasDeDistancia(h)} días de este pago`}</small>
                            <div className="cortes-dias">
                              {dd.map((d) => {
                                const ocupado = asignadosAOtros.has(d) || diasPropios.includes(d);
                                return (
                                  <button
                                    aria-pressed={diasElegidos.includes(d)}
                                    className={`cortes-dia${diasElegidos.includes(d) ? " is-mv" : ""}${ocupado ? " is-asignado" : ""}`}
                                    disabled={!puedeActuar || ocupado}
                                    key={d}
                                    onClick={() => alternarDia(d)}
                                    title={ocupado ? "Ya está asignado a un pago" : "Marcar para incluirlo en este pago"}
                                    type="button"
                                  >
                                    <small>{fechaConDia(d).replace(" ", "\n")}</small>
                                    {dias.get(d) ? `${(dias.get(d)! / 1000).toFixed(1)}k` : "—"}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {diasElegidos.length ? (
                      <>
                        <p>
                          Marcaste {diasElegidos.length} día(s), {pesos(sumaElegida)}. El pago quedaría en{" "}
                          <b>{textoDiferencia((pago.diferencia ?? 0) + sumaElegida)}</b> de diferencia.
                        </p>
                        <div className="cortes-acciones">
                          <button
                            className="cortes-boton is-primario"
                            disabled={!puedeActuar}
                            onClick={() =>
                              void editar(
                                "asignar-dias",
                                { pago_id: pago.pago_id, dias: [...diasPropios, ...diasElegidos].sort() },
                                "Cierre incluido en este pago.",
                                false
                              )
                            }
                            type="button"
                          >
                            Incluir en este pago
                          </button>
                          <button className="cortes-boton" onClick={() => setDiasElegidos([])} type="button">
                            Limpiar
                          </button>
                        </div>
                      </>
                    ) : huecosCierre.length ? (
                      <p className="hydro-muted">Marca los días que quieras sumar a este pago.</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {lineasPago?.lineas.length ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja">
                    <h3>Pagado por línea del pedido</h3>
                    <p className="hydro-muted">
                      {lineasPago.posicion ? `${lineasPago.posicion}. ` : ""}Cada línea de pasivo temporal de SAP es una familia de producto.
                    </p>
                    <table className="cortes-lineas">
                      <thead>
                        <tr>
                          <th>Línea</th>
                          <th>Pagado</th>
                          <th>Calculado</th>
                          <th>Dif.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineasPago.lineas.map((l) => (
                          <tr className={Math.abs(l.diferencia) > 10 ? "is-dif" : ""} key={l.linea}>
                            <td>
                              {l.linea} · {l.familia}
                            </td>
                            <td>{pesos(l.pagado)}</td>
                            <td>{pesos(l.calculado)}</td>
                            <td>{textoDiferencia(l.diferencia)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {(filaActual.skus ?? []).length ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja">
                    <h3>4 SKUs de Botana</h3>
                    <p className="hydro-muted">
                      Hasta agosto estos 4 materiales no se pagaron en su semana. Marca las semanas que este pago sí incluyó y verás cómo se reduce la diferencia.
                    </p>
                    <div className="cortes-skus">
                      {semanasSkus.map((b) => {
                        const aqui = b.pago_id === pago.pago_id;
                        const destino = b.pago_id ? filaActual.pagos.find((p) => p.pago_id === b.pago_id) : null;
                        const elegida = skusElegidos.includes(b.ini);
                        const editable = puedeEditar && !consolidado;
                        return (
                          <div className={`cortes-sku${aqui ? " is-aqui" : ""}${elegida ? " is-elegida" : ""}`} key={b.ini}>
                            {editable && !aqui ? (
                              <input
                                aria-label={`Incluir la semana ${rangoCorto(b.ini, b.fin)}`}
                                checked={elegida}
                                disabled={!puedeActuar}
                                onChange={() => setSkusElegidos((l) => (l.includes(b.ini) ? l.filter((x) => x !== b.ini) : [...l, b.ini]))}
                                type="checkbox"
                              />
                            ) : (
                              <span />
                            )}
                            <b>{rangoCorto(b.ini, b.fin)}</b>
                            <span>{pesos(b.comision)}</span>
                            <small>
                              {aqui
                                ? "En este pago"
                                : !b.pago_id
                                  ? "Sin pagar"
                                  : destino?.ini && destino.fin
                                    ? `En el pago ${rangoCorto(destino.ini, destino.fin)}`
                                    : "En otro pago"}
                            </small>
                            {editable && aqui ? (
                              <button
                                className="cortes-ir"
                                disabled={!puedeActuar}
                                onClick={() =>
                                  void editar("mover-skus", { bloques_ini: [b.ini], pago_id: null }, "Semana de 4 SKUs quitada de este pago.", false)
                                }
                                type="button"
                              >
                                Quitar
                              </button>
                            ) : (
                              <span />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {skusElegidos.length ? (
                      <>
                        <p>
                          Marcaste {skusElegidos.length} semana(s), {pesos(sumaSkusElegida)}. La diferencia pasa de{" "}
                          <b>{textoDiferencia(pago.diferencia)}</b> a <b>{textoDiferencia((pago.diferencia ?? 0) + sumaSkusElegida)}</b>.
                        </p>
                        <div className="cortes-acciones">
                          <button
                            className="cortes-boton is-primario"
                            disabled={!puedeActuar}
                            onClick={() =>
                              void editar(
                                "mover-skus",
                                { bloques_ini: skusElegidos, pago_id: pago.pago_id },
                                "Semanas de 4 SKUs incluidas en este pago.",
                                false
                              )
                            }
                            type="button"
                          >
                            Incluir en este pago
                          </button>
                          <button className="cortes-boton" onClick={() => setSkusElegidos([])} type="button">
                            Limpiar
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {pago.estado === "sin" && !pago.sin_calculo && !pendiente ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-error">
                    <h3>Sin explicación</h3>
                    <p>
                      {pago.descartada
                        ? "Descartaron la sugerencia de este pago."
                        : "Ningún ajuste de hasta 3 días en los cortes cuadra este pago."}
                    </p>
                    {pago.descartada && puedeEditar ? (
                      <div className="cortes-acciones">
                        <button
                          className="cortes-boton"
                          disabled={!puedeActuar}
                          onClick={() => void editar("recuperar", { pago_id: pago.pago_id })}
                          type="button"
                        >
                          Recuperar la sugerencia
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {consolidado ? (
                <div className="cortes-bloque">
                  <div className="cortes-caja is-consolidado">
                    <h3>Consolidado{pago.consolidado_por ? ` por ${pago.consolidado_por}` : ""}</h3>
                    <p>
                      {pago.consolidado_en ? `El ${fechaCorta(pago.consolidado_en.slice(0, 10))}. ` : ""}
                      Quedó con calculado {pago.calculado === null ? "—" : pesos(pago.calculado)} y pagado {pesos(pago.pagado)}; sus dos cortes están
                      congelados.
                    </p>
                    {Math.abs(pago.drift ?? 0) > 1 ? (
                      <p className="cortes-cambio">
                        ⚠ Los cobros cambiaron desde entonces: hoy el calculado sería{" "}
                        {pesos((pago.calculado ?? 0) + (pago.drift ?? 0))} ({textoDiferencia(pago.drift)}).
                      </p>
                    ) : null}
                    {Math.abs(pago.drift_pagado ?? 0) > 1 ? (
                      <p className="cortes-cambio">
                        ⚠ El pago en SAP cambió desde entonces: hoy figura {pesos(pago.pagado + (pago.drift_pagado ?? 0))} ({textoDiferencia(pago.drift_pagado ?? null)}).
                      </p>
                    ) : null}
                    {puedeEditar ? (
                      <div className="cortes-acciones">
                        <button className="cortes-boton" disabled={!puedeActuar} onClick={() => setReabrir([pago.pago_id])} type="button">
                          Reabrir pago
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="cortes-bloque cortes-pie">
                  <button
                    className="cortes-boton is-primario"
                    disabled={!puedeActuar || sinVentana}
                    onClick={() => void editar("consolidar", { pago_id: pago.pago_id }, "Pago consolidado.")}
                    type="button"
                  >
                    {pago.diferencia !== null && Math.abs(pago.diferencia) > 1
                      ? `Consolidar con diferencia de ${pesos(Math.abs(pago.diferencia))}`
                      : "Consolidar este pago"}
                  </button>
                  <span>{puedeEditar ? "Congela los dos cortes de este pago." : "Solo lectura: tu rol no puede editar los cortes."}</span>
                  {(pago.skus_propios ?? []).some((b) => !b.pago_id) ? (
                    <span className="cortes-aviso-skus">
                      Esta semana tiene {pesos((pago.skus_propios ?? []).filter((b) => !b.pago_id).reduce((t, b) => t + b.comision, 0))} de 4 SKUs sin pagar.
                    </span>
                  ) : null}
                </div>
              )}

              <div className="cortes-bloque">
                <div className="cortes-caja cortes-comentarios">
                  <h3>Comentarios</h3>
                  {(pago.comentarios ?? []).length ? (
                    <ul>
                      {(pago.comentarios ?? []).map((c) => (
                        <li key={c.id}>
                          <p>{c.texto}</p>
                          <small>
                            {c.por} · {c.ts ? formatoMomento.format(new Date(c.ts)) : "—"}
                            {puedeEditar ? (
                              <>
                                {" · "}
                                <button
                                  className="cortes-ir"
                                  disabled={!puedeActuar}
                                  onClick={() => void editar("borrar-comentario", { pago_id: pago.pago_id, comentario_id: c.id }, "Comentario borrado.", false)}
                                  type="button"
                                >
                                  Borrar
                                </button>
                              </>
                            ) : null}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {puedeEditar ? (
                    <>
                      <textarea
                        aria-label="Comentario sobre este pago"
                        maxLength={1000}
                        onChange={(e) => setComentario(e.target.value)}
                        placeholder="Escribe un comentario sobre este pago…"
                        rows={3}
                        value={comentario}
                      />
                      <div className="cortes-acciones">
                        <button
                          className="cortes-boton is-primario"
                          disabled={!puedeActuar || !comentario.trim()}
                          onClick={async () => {
                            if (await editar("comentar", { pago_id: pago.pago_id, texto: comentario.trim() }, "Comentario guardado.", false)) setComentario("");
                          }}
                          type="button"
                        >
                          Agregar comentario
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              <details className="cortes-historial" onToggle={(e) => void abrirHistorial((e.target as HTMLDetailsElement).open)}>
                <summary>Historial de esta fila</summary>
                {historial === null ? <p className="hydro-muted">Cargando…</p> : null}
                {historial && !historial.length ? <p className="hydro-muted">Sin cambios todavía.</p> : null}
                {historial?.length ? (
                  <ul>
                    {historial.map((e, i) => (
                      <li key={`${e.ts}-${i}`}>
                        <time>{e.ts ? formatoMomento.format(new Date(e.ts)) : "—"}</time>
                        <span>
                          {e.usuario ?? "—"} {describirEvento(e)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
