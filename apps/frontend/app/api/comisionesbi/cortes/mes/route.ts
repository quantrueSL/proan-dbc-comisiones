import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getCortesMes } from "@/lib/comisionesbi";
import type { CortesMesFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as CortesMesFilters;
    return NextResponse.json(await getCortesMes(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar la conciliación por cortes." },
      { status: 502 }
    );
  }
}
