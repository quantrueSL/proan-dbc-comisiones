import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getGcpProjectId } from "@/lib/env";

// ─────────────────────────────────────────────────────────────────────────
// App de firebase-admin compartida por la lectura de Firestore (Capa 1) y la
// verificación de tokens de Google (Capa 2). SOLO SERVIDOR.
//
// Se usa un nombre propio en vez de la app por defecto para no chocar con
// ninguna otra inicialización, y porque en `next dev` los módulos se recargan:
// sin la comprobación de `getApps()` el segundo arranque lanzaría
// "app already exists".
//
// Credenciales: `applicationDefault()`. En Cloud Run sale de la identidad del
// servicio; en local, de GOOGLE_APPLICATION_CREDENTIALS (ver compose de dev).
// ─────────────────────────────────────────────────────────────────────────

const APP_NAME = "dbc-comisiones-auth";

export function getAuthApp(): App {
  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing) {
    return existing;
  }
  return initializeApp(
    { credential: applicationDefault(), projectId: getGcpProjectId() },
    APP_NAME
  );
}
