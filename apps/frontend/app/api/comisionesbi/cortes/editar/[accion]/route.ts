import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { esAccionDeEdicion, postCortesEdicion } from "@/lib/comisionesbi";

// Una sola ruta para las ediciones de la conciliación por cortes. El usuario y el rol los pone
// el servidor desde la sesión firmada: el backend (sin URL pública) confía en esos encabezados.
export async function POST(request: Request, { params }: { params: { accion: string } }) {
  const sesion = requireSession();
  if (!esAccionDeEdicion(params.accion)) {
    return NextResponse.json({ detail: "Acción desconocida." }, { status: 404 });
  }
  try {
    const cuerpo = (await request.json()) as unknown;
    const { status, payload } = await postCortesEdicion(params.accion, cuerpo, {
      usuario: sesion.email || sesion.username,
      rol: sesion.role
    });
    return NextResponse.json(payload ?? {}, { status });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "No se pudo guardar el cambio." },
      { status: 502 }
    );
  }
}
