import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getCortesFila } from "@/lib/comisionesbi";
import type { CortesFilaFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as CortesFilaFilters;
    return NextResponse.json(await getCortesFila(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar el pago." },
      { status: 502 }
    );
  }
}
