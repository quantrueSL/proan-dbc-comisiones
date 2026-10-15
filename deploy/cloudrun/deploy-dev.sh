#!/usr/bin/env bash
# Despliega una copia de pruebas (plataforma-comisiones-dbc-dev) para ensenar el trabajo en curso,
# sin tocar el servicio de siempre. Mismas imagenes, secretos, cuenta de servicio y Firestore.
#
#   bash deploy/cloudrun/deploy-dev.sh
#
# La primera vez, anade la URL que imprime en Firebase Console -> Authentication ->
# Settings -> Authorized domains (ver README.md, seccion "Servicio de pruebas").
set -euo pipefail
SERVICE="plataforma-comisiones-dbc-dev" bash "$(dirname "$0")/deploy.sh"
