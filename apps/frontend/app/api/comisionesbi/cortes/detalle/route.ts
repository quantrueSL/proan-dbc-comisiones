import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getCortesDetalle } from "@/lib/comisionesbi";
import type { CortesDetalleFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as CortesDetalleFilters;
    return NextResponse.json(await getCortesDetalle(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar el detalle." },
      { status: 502 }
    );
  }
}
