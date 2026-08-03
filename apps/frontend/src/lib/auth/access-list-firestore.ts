import { getFirestore } from "firebase-admin/firestore";
import { getAuthApp } from "@/lib/auth/firebase-admin";
import {
  getAccessListCacheTtlSeconds,
  getAccessListDatabaseId,
  getAccessListDocumentId
} from "@/lib/env";
import { parseAccessList, resolveAccessDecision, type AccessDecision, type AccessList } from "@/lib/auth/access-list";

// ─────────────────────────────────────────────────────────────────────────
// Lectura de la lista de acceso desde Firestore.
//
// SOLO SERVIDOR. No importar desde un componente de cliente: arrastraría el SDK
// de administración al navegador.
//
// Credenciales: `applicationDefault()`. En Cloud Run sale de la identidad del
// servicio; en local, de GOOGLE_APPLICATION_CREDENTIALS (ver el compose de dev).
// ─────────────────────────────────────────────────────────────────────────

const LISTS_COLLECTION = "lists";

type CacheEntry = { list: AccessList | null; expiresAt: number };

let cache: CacheEntry | null = null;
// Evita que N peticiones simultáneas lancen N lecturas mientras la caché está fría.
let inFlight: Promise<AccessList | null> | null = null;

async function fetchAccessList(): Promise<AccessList | null> {
  const firestore = getFirestore(getAuthApp(), getAccessListDatabaseId());
  const snapshot = await firestore.collection(LISTS_COLLECTION).doc(getAccessListDocumentId()).get();

  if (!snapshot.exists) {
    return null;
  }
  return parseAccessList(snapshot.data());
}

async function readAccessList(): Promise<AccessList | null> {
  const now = Date.now();

  if (cache && cache.expiresAt > now) {
    return cache.list;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchAccessList()
    .then((list) => {
      // La caché solo guarda lecturas correctas: un fallo no se memoriza, para
      // que el siguiente intento vuelva a preguntar.
      cache = { list, expiresAt: Date.now() + getAccessListCacheTtlSeconds() * 1000 };
      return list;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Decide si un correo puede entrar y con qué rol.
 *
 * Si Firestore falla se devuelve `unavailable`, que el llamante trata como
 * denegación: sin lista no se concede acceso (LOGIN.md, Capa 1). Tampoco se
 * sirve una copia caducada de la caché — eso alargaría indefinidamente la
 * ventana en la que un usuario dado de baja sigue entrando.
 */
export async function resolveAccessDecisionForEmail(email: string): Promise<AccessDecision> {
  let list: AccessList | null;
  try {
    list = await readAccessList();
  } catch (cause) {
    console.error("No se pudo leer la lista de acceso en Firestore", cause);
    return { status: "unavailable" };
  }
  return resolveAccessDecision(list, email);
}

/** Fuerza la relectura en la siguiente consulta. Para operativa y pruebas. */
export function invalidateAccessListCache(): void {
  cache = null;
}
