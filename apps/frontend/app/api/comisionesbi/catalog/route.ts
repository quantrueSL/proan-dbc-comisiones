import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog } from "@/lib/comisionesbi";

export async function GET() {
  requireSession();
  try {
    return NextResponse.json(await getComisionesCatalog());
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo cargar el catálogo." },
      { status: 502 }
    );
  }
}
