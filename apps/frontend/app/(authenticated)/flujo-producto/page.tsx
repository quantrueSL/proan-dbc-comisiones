import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getFlujoProducto } from "@/lib/comisionesbi";
import { rangoPorDefectoCompartido } from "@/lib/rango-por-defecto";
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
  sociedad?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fecha(valor: string | undefined, porDefecto: string): string {
  // La URL la escribe cualquiera: si no es una fecha ISO se ignora en vez de
  // mandarle basura al backend y comerse un 422.
  return valor && ISO_DATE.test(valor) ? valor : porDefecto;
}

export default async function FlujoProductoPage({ searchParams }: { searchParams: SearchParams }) {
  requireSession();

  // El rango por defecto vive en `@/lib/rango-por-defecto`, compartido con
  // Comisiones (`app/(authenticated)/comisiones/page.tsx`) -- ver ese módulo
  // para el porqué de los 6 meses. La fecha de corte real de cada fase la
  // devuelve `cobertura`; aquí no se escribe ninguna, que envejecen mal.
  const porDefecto = rangoPorDefectoCompartido();
  const desde = fecha(searchParams.desde, porDefecto.desde);
  const hasta = fecha(searchParams.hasta, porDefecto.hasta);
  const division = searchParams.division?.trim() || null;
  const cedis = searchParams.cedis?.trim() || null;
  const tipoVenta = searchParams.tipo_venta?.trim() || null;
  const sociedad = searchParams.sociedad?.trim() || null;

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let flujo: FlujoResponse = EMPTY_FLUJO;
  let error: string | null = null;

  // Las dos en paralelo: son independientes y el sidecar arranca en frío.
  const [catalogo, movimientos] = await Promise.allSettled([
    getComisionesCatalog(),
    getFlujoProducto({ division, cedis, tipo_venta: tipoVenta, sociedad, start_date: desde, end_date: hasta })
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
      filtros={{ desde, hasta, division, cedis, tipoVenta, sociedad }}
    />
  );
}
