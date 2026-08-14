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
`proan-hidrocarburos` para BigQuery y Firebase. Con app web propia,
**`comisiones-dbc-frontend`** (`appId` acabado en `…24712b699cf9bf2750beca`),
como tienen las demás herramientas del proyecto: `hidrocarburos-frontend`,
`pedidos-dbc`, `MAKA-rentabilidad` y `portal-proan-web`.

Su `apiKey` y su `appId` están puestos como valores planos en
`deploy/cloudrun/service.yaml` y `deploy/docker-compose.dev.yml`. No es un
descuido: son públicos por diseño, viajan en el JavaScript del navegador de
cualquiera que abra el login. Lo que decide quién entra es la lista de
Firestore (§4), no esa clave.

Falta un paso que solo se puede dar **después del primer despliegue**: añadir la
URL de Cloud Run en Firebase Console → *Authentication* → *Settings* →
*Authorized domains*. Sin eso el botón de Google falla con
`auth/unauthorized-domain`.

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
| `FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN` / `FIREBASE_APP_ID` | config pública del SDK web (app ya registrada, ver §2). Si falta cualquiera de las tres, `getFirebaseWebConfig()` devuelve `null`, el botón de Google no se pinta y la pantalla se repliega al usuario/contraseña |

Con `docker compose` estas variables las pone `deploy/docker-compose.dev.yml`.
Levantando el frontend a mano (`pnpm dev`) no existen, así que hay plantilla:
`cp apps/frontend/.env.local.example apps/frontend/.env.local`. Fue justo el
motivo por el que el botón de Google no aparecía corriendo fuera de Docker.

## 6. Estado

Hecho (2026-08-13):

- App web `comisiones-dbc-frontend` registrada y sus valores puestos (§2).
- Secretos `dbc-comisiones-session-secret` y `dbc-comisiones-htpasswd` creados
  en Secret Manager, legibles por la identidad del servicio (ver
  `deploy/cloudrun/README.md`).
- Documento `lists/dbc_comisiones_acceso` creado con los primeros cinco
  correos, `enabled: true` y `roles` vacío — o sea, todos entran como `viewer`.

Hecho (2026-08-14):

- Botón de Google comprobado en local, con el stack de `docker compose`
  (http://localhost:8080). La lista de acceso se leyó de Firestore y responde:
  `enabled: true`, los cinco correos, `roles` vacío. Para entrar hay que usar
  una de esas cinco cuentas; cualquier otra se rechaza (la lista es la puerta).
- Plantilla `apps/frontend/.env.local.example` para levantar el frontend sin
  Docker (§5).

Pendiente:

- **Definir los roles reales con el cliente** (§3). Hoy el rol no controla nada:
  `isAdmin()` está definido en `roles.ts` y no se usa en ninguna pantalla ni en
  ninguna ruta de API, así que un `admin` y un `viewer` ven exactamente lo
  mismo. Lo único que decide algo es estar o no estar en `emails`.
- **Autorizar el dominio de Cloud Run** en Firebase Console, después del primer
  despliegue (§2).
