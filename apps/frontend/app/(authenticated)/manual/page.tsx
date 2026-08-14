import { requireSession } from "@/lib/auth/session";
import { getComisionesCatalog, getFlujoProducto } from "@/lib/comisionesbi";
import { FlujoManual } from "@/features/flujo-producto/flujo-manual";
import { ManualGlosario, ManualIntro, ManualModulos } from "@/features/manual/manual-intro";
import { ManualIndice } from "@/features/manual/manual-indice";
import { ManualRecorrido } from "@/features/manual/manual-recorrido";
import type { FlujoCobertura } from "@/types/comisiones";

export const metadata = { title: "Manual · Comisiones DBC" };

export default async function ManualPage() {
  requireSession();

  // Se pide un rango mínimo solo para traer `cobertura`: el manual dice hasta
  // qué fecha hay datos de cada fase, y eso tiene que salir de los datos. Si se
  // escribiera a mano, el manual seguiría avisando de un problema ya resuelto.
  // Consulta la tabla gold (4,7 MB), así que cuesta lo mismo que nada.
  //
  // El catálogo se pide en paralelo por lo mismo: cuántos CEDIS hay es un dato,
  // no una frase. Si falla, el manual se lee igual y solo pierde ese número.
  let cobertura: FlujoCobertura = {};
  let cedis = 0;
  let error: string | null = null;

  const hoy = new Date().toISOString().slice(0, 10);
  const [flujo, catalogo] = await Promise.allSettled([
    getFlujoProducto({ division: null, cedis: null, start_date: hoy, end_date: hoy }),
    getComisionesCatalog()
  ]);

  if (flujo.status === "fulfilled") {
    cobertura = flujo.value.cobertura;
  } else {
    error = flujo.reason instanceof Error ? flujo.reason.message : "No se pudieron leer las fechas de los datos.";
  }
  if (catalogo.status === "fulfilled") {
    cedis = catalogo.value.cedis.length;
  }

  return (
    <div className="hydro-page manual-page">
      <header className="manual-portada">
        {/* Título y cifras en dos bloques, no cinco hijos sueltos: así la
            cabecera puede ponerlos en dos columnas en pantalla ancha sin
            colocar cada elemento a mano en la rejilla. */}
        <div className="manual-portada-titulo">
          <p>Manual de usuario</p>
          <h1>
            Comisiones <span>DBC</span>
          </h1>
          <p className="manual-portada-texto">
            DBC recibe producto del grupo Proan y lo distribuye por sus CEDIS. Esta plataforma sigue
            ese producto desde que entra hasta que se cobra, calcula la comisión que toca pagar —solo
            sobre lo cobrado— y guarda el respaldo documental de cada pago.
          </p>
        </div>
        <div className="manual-portada-datos">
          <span>
            <b>4</b> capas de datos
          </span>
          <span>
            <b>3</b> módulos
          </span>
          {cedis ? (
            <span>
              <b>{cedis}</b> combinaciones de CEDIS
            </span>
          ) : null}
          <span>
            desde <b>enero de 2026</b>
          </span>
        </div>
        <div className="manual-portada-linea" aria-hidden="true" />
      </header>

      {error ? <p className="hydro-error">{error}</p> : null}

      {/* El índice va PRIMERO en el HTML aunque se pinte a la derecha (lo coloca
          la rejilla): quien navega con teclado o lector de pantalla se
          encuentra el sumario antes del manual, que es lo que espera de un
          sumario. */}
      <div className="manual-cuerpo">
        <ManualIndice />

        {/* El `id` lo usa la barra de avance del índice para medir contra el
            manual y no contra la página entera. */}
        <div className="manual-hoja" id="manual-contenido">
          <ManualIntro />
          <ManualRecorrido />
          <ManualModulos />
          <FlujoManual cobertura={cobertura} />
          <ManualGlosario />
        </div>
      </div>
    </div>
  );
}
