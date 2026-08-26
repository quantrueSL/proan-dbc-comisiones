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
      // Comisiones dejó de devolver 501 el 25/08/2026, cuando el módulo
      // empezó a calcular. La rama se queda porque el contrato sigue siendo
      // ese: si algún día vuelve a bloquearse, el motivo llega al usuario en
      // vez de un error genérico.
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo generar el reporte de comisión." },
      { status: 502 }
    );
  }
}
