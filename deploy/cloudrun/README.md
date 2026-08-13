# Despliegue en Cloud Run

Un servicio, `plataforma-comisiones-dbc`, con dos contenedores: el frontend Next.js
como entrada y `comisionesbi` como sidecar en `localhost:8091`. El backend no tiene
URL pública, así que no hay autenticación entre servicios que mantener.

Proyecto `proan-quantrue`, región `us-west4` — la misma que BigQuery
(`BQ_LOCATION`), para no pagar latencia entre regiones.

Patrón calcado de `proan-hidrocarburos/deploy/cloudrun/`.

## Preparación (solo la primera vez)

**1. Secreto de firma de sesión.** Sin él el frontend no arranca, a propósito:
una sesión sin firmar sería falsificable.

```bash
openssl rand -base64 48 | tr -d '\n' | \
  gcloud secrets create dbc-comisiones-session-secret --data-file=- \
    --project=proan-quantrue --replication-policy=automatic
```

**2. Usuarios técnicos (`.htpasswd`).** Se sube como secreto y se monta como
fichero en `/etc/dbc/.htpasswd`; así los hashes no viven en el repositorio ni se
hornean en la imagen.

```bash
gcloud secrets create dbc-comisiones-htpasswd --data-file=deploy/nginx/.htpasswd \
  --project=proan-quantrue --replication-policy=automatic
```

**3. Permiso de lectura de secretos** para la identidad del servicio:

```bash
for s in dbc-comisiones-session-secret dbc-comisiones-htpasswd; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member=serviceAccount:272166156031-compute@developer.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor --project=proan-quantrue
done
```

**4. App web de Firebase.** Registrar una app web nueva "comisiones-dbc-frontend"
en Firebase Console (mismo proyecto `proan-quantrue` que ya usa
`proan-hidrocarburos`) y sustituir los valores `FIREBASE_API_KEY`/`FIREBASE_APP_ID`
en `service.yaml` y en `deploy/docker-compose.dev.yml` — hoy son placeholders sin
configurar. Ver `LOGIN.md` para el detalle del patrón.

## Desplegar

```bash
bash deploy/cloudrun/deploy.sh
```

Construye las dos imágenes con una etiqueta única, renderiza `service.yaml` y
reemplaza el servicio. Al terminar imprime la URL.

**La primera vez**, añade esa URL en Firebase Console → *Authentication* →
*Settings* → *Authorized domains*, o el botón de Google fallará con
`auth/unauthorized-domain`.

## Añadir un usuario técnico

No hace falta reconstruir imágenes, pero sí una revisión nueva: los secretos
montados como fichero se resuelven al arrancar la instancia.

```bash
htpasswd -B deploy/nginx/.htpasswd nuevousuario
gcloud secrets versions add dbc-comisiones-htpasswd --data-file=deploy/nginx/.htpasswd \
  --project=proan-quantrue
bash deploy/cloudrun/deploy.sh
```

Para los usuarios normales de la herramienta no hay que desplegar nada: se
gestionan en la lista de Firestore desde el portal de listas (ver `LOGIN.md`).

## Decisiones y detalles

- **Etiqueta única por despliegue** (`sha-fecha`). Con `:latest`, el spec del
  servicio no cambiaría, `gcloud run services replace` no crearía revisión y
  seguiría sirviendo la imagen anterior sin avisar.
- **`--allow-unauthenticated`** (vía `add-iam-policy-binding`): un navegador no
  envía tokens de IAM, así que cerrarlo dejaría fuera a todo el mundo. El login lo
  gestiona la aplicación. Cerrarlo de verdad sería poner IAP delante.
- **`min-instances: 0`.** Habrá arranque en frío en la primera petición, y el
  sidecar carga pandas y pyarrow, así que no es instantáneo. Subirlo a 1 lo evita
  a cambio de pagar la instancia 24×7.
- **Caché del catálogo (`CATALOG_CACHE_TTL_SECONDS`, 3600).** El catálogo de
  división/CEDIS se cachea en memoria del proceso, así que muere en cada arranque
  en frío y cada instancia tiene la suya: no hay invalidación global sin
  desplegar. Es también la ventana en la que un CEDIS nuevo tarda en aparecer en
  los filtros. Si BigQuery falla y hay una copia caducada se sirve esa, con un
  aviso en el log, antes que devolver un 503.
- **`DOCKER_BUILDKIT=1`** en `cloudbuild.yaml`: el Dockerfile de `comisionesbi` usa
  `RUN --mount=type=cache`, que el constructor clásico no entiende.
- **Sin `BQ_CREDENTIALS_PATH`**: `db.py` cae a credenciales de aplicación, que en
  Cloud Run son la identidad del servicio. El JSON no entra en la imagen.
- La identidad del servicio es `272166156031-compute@`, la misma que el resto del
  proyecto (mismo proyecto GCP que `proan-hidrocarburos`). Tiene rol *Editor*,
  mucho más de lo necesario; queda pendiente crear una service account dedicada
  con permisos mínimos.

En desarrollo (`deploy/docker-compose.dev.yml`) sí hay nginx delante: da el puerto
de entrada estable y el `Upgrade` de websockets para el recargado en caliente de
Next. En producción no hace falta.
