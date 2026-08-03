import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog } from "@/lib/comisionesbi";
import { FlujoProductoWorkspace } from "@/features/flujo-producto/flujo-producto-workspace";
import { EMPTY_CATALOG, type ComisionesCatalog } from "@/types/comisiones";

export default async function FlujoProductoPage() {
  requireSession();

  let catalog: ComisionesCatalog = EMPTY_CATALOG;
  let error: string | null = null;

  try {
    catalog = await getComisionesCatalog();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "No se pudo cargar el catálogo de división/CEDIS.";
  }

  return <FlujoProductoWorkspace initialCatalog={catalog} initialError={error} />;
}
