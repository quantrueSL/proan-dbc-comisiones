import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getFlujoProducto } from "@/lib/comisionesbi";
import { FlujoProductoWorkspace } from "@/features/flujo-producto/flujo-producto-workspace";
import {
  EMPTY_CATALOG,
  EMPTY_FLUJO,
  type ComisionesCatalog,
  type FlujoResponse
} from "@/types/comisiones";

// Los filtros viajan en la URL en vez de en estado de cliente: así el periodo
// es enlazable y compartible, y el trabajo lo sigue haciendo el servidor.
type SearchParams = {
  desde?: string;
  hasta?: string;
  division?: string;
  cedis?: string;
  tipo_venta?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fecha(valor: string | undefined, porDefecto: string): string {
  // La URL la escribe cualquiera: si no es una fecha ISO se ignora en vez de
  // mandarle basura al backend y comerse un 422.
  return valor && ISO_DATE.test(valor) ? valor : porDefecto;
}

/**
 * Por defecto, desde el día 1 del mes pasado hasta hoy. Cubre siempre un mes
 * completo más el corriente, que es lo mínimo para que las tres fases tengan
 * datos: "vendido" se corta el 20/07/2026 (ver data/notas/07).
 */
function rangoPorDefecto(): { desde: string; hasta: string } {
  const hoy = new Date();
  const inicioMesPasado = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
  return {
    desde: inicioMesPasado.toISOString().slice(0, 10),
    hasta: hoy.toISOString().slice(0, 10)
  };
}

export default async function FlujoProductoPage({ searchParams }: { searchParams: SearchParams }) {
  requireSession();

  const porDefecto = rangoPorDefecto();
  const desde = fecha(searchParams.desde, porDefecto.desde);
  const hasta = fecha(searchParams.hasta, porDefecto.hasta);
  const division = searchParams.division?.trim() || null;
  const cedis = searchParams.cedis?.trim() || null;
  const tipoVenta = searchParams.tipo_venta?.trim() || null;

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let flujo: FlujoResponse = EMPTY_FLUJO;
  let error: string | null = null;

  // Las dos en paralelo: son independientes y el sidecar arranca en frío.
  const [catalogo, movimientos] = await Promise.allSettled([
    getComisionesCatalog(),
    getFlujoProducto({ division, cedis, tipo_venta: tipoVenta, start_date: desde, end_date: hasta })
  ]);

  if (catalogo.status === "fulfilled") {
    catalog = catalogo.value;
  } else {
    error = catalogo.reason instanceof Error ? catalogo.reason.message : "No se pudo cargar el catálogo.";
  }

  if (movimientos.status === "fulfilled") {
    flujo = movimientos.value;
  } else {
    // Si fallan las dos, se enseña el motivo del flujo: es el contenido principal.
    error = movimientos.reason instanceof Error ? movimientos.reason.message : "No se pudo cargar el flujo.";
  }

  return (
    <FlujoProductoWorkspace
      initialCatalog={catalog}
      initialError={error}
      initialFlujo={flujo}
      filtros={{ desde, hasta, division, cedis, tipoVenta }}
    />
  );
}
