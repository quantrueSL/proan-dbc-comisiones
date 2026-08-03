import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { BackendNotReadyError, getComisionesReconciliation } from "@/lib/comisionesbi";
import type { ReconciliationFilters } from "@/types/comisiones";

export async function POST(request: Request) {
  requireSession();
  try {
    const body = (await request.json()) as ReconciliationFilters;
    return NextResponse.json(await getComisionesReconciliation(body));
  } catch (error) {
    if (error instanceof BackendNotReadyError) {
      return NextResponse.json({ detail: error.message }, { status: 501 });
    }
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar la conciliación." },
      { status: 502 }
    );
  }
}
