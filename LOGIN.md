# Login de Comisiones DBC

Mismo patrón que `proan-hidrocarburos` (ver ahí `LOGIN_NEW.md` para la guía
genérica y las trampas, escrita justo para reutilizarse en otra herramienta).
Aquí solo las decisiones específicas de este proyecto.

## 1. Dos vías, una sola sesión

- **Google (Firebase Authentication)** — para los usuarios reales. Verifica
  quién eres; el rol sale de la lista de acceso (§4), no de Google.
- **Usuario/contraseña (`.htpasswd`, bcrypt)** — acceso técnico/desarrollo.
  Siempre entra con el rol `admin`.

Ambas emiten la misma cookie de sesión firmada (`dbc_comisiones_session`); a
partir de ahí la aplicación no distingue por dónde entró nadie.

## 2. Proyecto Firebase / GCP

Mismo proyecto que el resto del grupo (`proan-quantrue`), el mismo que ya usa
`proan-hidrocarburos` para BigQuery y Firebase. **Pendiente**: registrar una
app web propia "comisiones-dbc-frontend" en Firebase Console (Configuración
del proyecto → Tus apps) — hoy `FIREBASE_API_KEY`/`FIREBASE_APP_ID` son
placeholders sin configurar en `deploy/docker-compose.dev.yml` y
`deploy/cloudrun/service.yaml`.

## 3. Roles — PROVISIONAL

```
admin   → puede todo.
viewer  → solo consulta.
```

Todavía no se han definido con el cliente los roles reales de Comisiones DBC
(por ejemplo, podría necesitarse algo más granular: por CEDIS, por función
comercial, etc.). Ajustar en `apps/frontend/src/lib/auth/roles.ts` y
`apps/frontend/src/types/auth.ts` cuando se sepa.

## 4. La lista de acceso

Documento Firestore `lists/dbc_comisiones_acceso`, base `proan-lista-mails`
(la misma que gestiona Mailing-lists), mismo patrón que
`lists/hidrocarburos_acceso`:

```
emails:  ["persona@proan.com"]        ← quién entra
roles:   { "persona@proan.com": "admin" }   ← qué puede hacer
enabled: true
```

Reglas (ver `LOGIN_NEW.md` de `proan-hidrocarburos` para el detalle): la lista
de correos es la puerta, los roles solo reparten; sin rol asignado o con un
rol irreconocible se degrada al menos privilegiado (`viewer`), nunca al revés.

## 5. Variables de entorno relevantes (frontend)

| Variable | Rol |
|---|---|
| `SESSION_SECRET` | firma la cookie — obligatorio en producción, vía Secret Manager (`dbc-comisiones-session-secret`) |
| `SESSION_COOKIE_NAME` | `dbc_comisiones_session` |
| `HTPASSWD_PATH` | ruta al fichero de usuarios técnicos |
| `GCP_PROJECT` / `FIRESTORE_DATABASE_ID` / `ACCESS_LIST_ID` | ubicación de la lista de acceso |
| `FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN` / `FIREBASE_APP_ID` | config pública del SDK web (pendiente registrar app, ver §2) |

## 6. Pendiente antes de producción

- Registrar la app web de Firebase (§2) y sustituir los placeholders.
- Definir los roles reales con el cliente (§3).
- Crear el documento `lists/dbc_comisiones_acceso` en Firestore con los
  primeros usuarios.
- Crear los secretos `dbc-comisiones-session-secret` y
  `dbc-comisiones-htpasswd` (ver `deploy/cloudrun/README.md`).
