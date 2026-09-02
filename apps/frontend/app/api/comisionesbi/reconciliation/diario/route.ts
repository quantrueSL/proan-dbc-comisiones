import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getComisionesReconciliationDiario } from "@/lib/comisionesbi";
import type { ConciliacionFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as ConciliacionFilters;
    return NextResponse.json(await getComisionesReconciliationDiario(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar el detalle diario." },
      { status: 502 }
    );
  }
}
