#!/usr/bin/env bash
# Despliegue de Comisiones DBC en Cloud Run (un servicio, dos contenedores).
#
#   bash deploy/cloudrun/deploy.sh
#
# Requiere que existan los secretos dbc-comisiones-session-secret y
# dbc-comisiones-htpasswd; ver deploy/cloudrun/README.md para crearlos la
# primera vez.
#
# OJO: no metas comentarios entre las lineas de un comando encadenado con "\".
# Un "#" en medio corta el comando y bash intenta ejecutar el resto.
set -euo pipefail

PROJECT="proan-quantrue"
REGION="us-west4"
SERVICE="plataforma-comisiones-dbc"
REPO="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy"
# Mismo proyecto que proan-hidrocarburos → misma cuenta de servicio de cómputo
# por defecto. Verificar si cambia.
SERVICE_ACCOUNT="272166156031-compute@developer.gserviceaccount.com"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Etiqueta unica por despliegue. Con ":latest" el spec del servicio no cambiaria
# entre despliegues, `services replace` no crearia revision nueva y seguiria
# sirviendo la imagen anterior sin avisar.
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d-%H%M%S)"

echo "== Comprobando secretos =="
for secret in dbc-comisiones-session-secret dbc-comisiones-htpasswd; do
  if ! gcloud secrets describe "$secret" --project="$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: falta el secreto '$secret'." >&2
    echo "       Crealo siguiendo deploy/cloudrun/README.md antes de desplegar." >&2
    exit 1
  fi
done

echo "== Construyendo imagenes ($TAG) =="
gcloud builds submit . \
  --project="$PROJECT" \
  --config=deploy/cloudrun/cloudbuild.yaml \
  --substitutions="_REPO=${REPO},_TAG=${TAG}"

echo "== Desplegando servicio =="
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed \
  -e "s|__REPO__|${REPO}|g" \
  -e "s|__TAG__|${TAG}|g" \
  -e "s|__SERVICE_ACCOUNT__|${SERVICE_ACCOUNT}|g" \
  deploy/cloudrun/service.yaml > "$RENDERED"

gcloud run services replace "$RENDERED" \
  --project="$PROJECT" \
  --region="$REGION"

# El servicio es publico a nivel de red y el login lo gestiona la aplicacion: un
# navegador no envia tokens de IAM, asi que sin esto no entraria nadie. Cerrarlo
# de verdad seria poner IAP delante.
echo "== Permitiendo invocacion publica =="
gcloud run services add-iam-policy-binding "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --member=allUsers \
  --role=roles/run.invoker >/dev/null

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"

echo
echo "Desplegado en: $URL"
echo
echo "Si es la primera vez, anade ese dominio en Firebase Console ->"
echo "Authentication -> Settings -> Authorized domains, o el boton de Google"
echo "fallara con auth/unauthorized-domain."
