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
 * Por defecto, todo 2026 (desde donde arrancan los datos) hasta hoy — el mismo
 * rango que Comisiones (`app/(authenticated)/comisiones/page.tsx`), a
 * propósito: cambiar de pantalla con un periodo distinto en cada una confunde
 * más de lo que ayuda. Antes era "mes pasado + el corriente", pero un rango
 * corto tiene el problema contrario al de Comisiones (que ya lo documentaba):
 * si una fase va retrasada — a "vendido" le ha pasado más de una vez, ver
 * data/notas/hallazgos.md — un mes suelto puede no traer nada de esa fase y
 * parecer un hueco de datos en vez de una serie completa con un tramo reciente
 * flojo. Con todo el año, ese tramo se ve en su proporción real. La fecha de
 * corte real de cada fase la devuelve `cobertura`; aquí no se escribe
 * ninguna, que envejecen mal.
 */
function rangoPorDefecto(): { desde: string; hasta: string } {
  const hoy = new Date();
  return {
    desde: "2026-01-01",
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
