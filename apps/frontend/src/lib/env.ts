import type { FirebaseWebConfig } from "@/types/auth";

function readEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/** URL del servicio comisionesbi (backend FastAPI + BigQuery), sidecar en Cloud Run. */
export function getComisionesbiServiceUrl(): string {
  return readEnv("COMISIONESBI_SERVICE_URL", "http://localhost:8091");
}

/** Ruta al fichero .htpasswd usado para autenticar el login. */
export function getHtpasswdPath(): string {
  return readEnv("HTPASSWD_PATH", "/app/.htpasswd");
}

/** TTL de la sesión (segundos). Por defecto 8 h. */
export function getSessionTtlSeconds(): number {
  const parsed = Number.parseInt(readEnv("SESSION_TTL_SECONDS", "28800"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 28800;
}

export function getSessionCookieName(): string {
  return readEnv("SESSION_COOKIE_NAME", "dbc_comisiones_session");
}

// ─── Firebase Authentication (LOGIN.md Capa 2) ───────────────────────────

/**
 * Configuración del SDK web, leída en el SERVIDOR y pasada como props al
 * componente del botón. Deliberadamente sin el prefijo `NEXT_PUBLIC_`: esas
 * variables se incrustan en el bundle al compilar, así que la misma imagen no
 * podría servir para dos entornos. Leyéndolas en el servidor, la configuración
 * es de despliegue y no de build.
 *
 * Devuelve null si no está configurada: entonces el login solo ofrece htpasswd,
 * sin romperse.
 */
export function getFirebaseWebConfig(): FirebaseWebConfig | null {
  const apiKey = process.env.FIREBASE_API_KEY?.trim() ?? "";
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() ?? "";
  const appId = process.env.FIREBASE_APP_ID?.trim() ?? "";

  if (!apiKey || !authDomain || !appId) {
    return null;
  }

  return { apiKey, authDomain, projectId: getGcpProjectId(), appId };
}

// ─── Lista de acceso en Firestore (LOGIN.md §4) ──────────────────────────

/** Proyecto GCP donde viven Firestore y, más adelante, Firebase Auth. Mismo proyecto que BigQuery. */
export function getGcpProjectId(): string {
  return readEnv("GCP_PROJECT", "proan-quantrue");
}

/** Base de datos Firestore CON NOMBRE (no es la default). */
export function getAccessListDatabaseId(): string {
  return readEnv("FIRESTORE_DATABASE_ID", "proan-lista-mails");
}

/** Documento dentro de la colección `lists`. */
export function getAccessListDocumentId(): string {
  return readEnv("ACCESS_LIST_ID", "dbc_comisiones_acceso");
}

/**
 * TTL de la caché de la lista. Es también la ventana en la que un alta o una
 * baja tarda en surtir efecto, así que no conviene subirlo mucho.
 */
export function getAccessListCacheTtlSeconds(): number {
  const parsed = Number.parseInt(readEnv("ACCESS_LIST_CACHE_TTL_SECONDS", "45"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45;
}

// Secreto con el que se firma la cookie de sesión. En producción es obligatorio:
// sin él la sesión volvería a ser falsificable, así que se prefiere fallar al
// arrancar antes que servir sesiones sin firma real.
const DEV_SESSION_SECRET = "dbc-comisiones-dev-session-secret-no-usar-en-produccion";
const MIN_SESSION_SECRET_LENGTH = 32;
let devSecretWarned = false;

export function getSessionSecret(): string {
  const value = process.env.SESSION_SECRET?.trim() ?? "";

  if (process.env.NODE_ENV === "production") {
    if (value.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET es obligatorio en producción y debe tener al menos ${MIN_SESSION_SECRET_LENGTH} caracteres.`
      );
    }
    return value;
  }

  if (value.length > 0) {
    return value;
  }

  if (!devSecretWarned) {
    devSecretWarned = true;
    console.warn("SESSION_SECRET no está definido: se usa el secreto de desarrollo.");
  }
  return DEV_SESSION_SECRET;
}

export function isSecureSessionCookie(): boolean {
  return readEnv("SESSION_COOKIE_SECURE", "false").toLowerCase() === "true";
}
