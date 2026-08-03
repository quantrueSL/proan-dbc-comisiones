import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getComisionesReport } from "@/lib/comisionesbi";
import type { ReportFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as ReportFilters;
    return NextResponse.json(await getComisionesReport(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      // 501 se propaga tal cual: el frontend lo usa para mostrar el motivo
      // real del bloqueo (GS03 / ZSDFI_001), no un error genérico.
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo generar el reporte de comisión." },
      { status: 502 }
    );
  }
}
