# Comisiones DBC

Plataforma de comisiones y conciliación documental para DBC (distribuidor del
grupo Proan). Consolida datos de SAP (vía BigQuery) para dar visión del flujo
de producto por CEDIS (traspasos → vendido → facturado → cobrado/compensado),
calcular la comisión que corresponde pagar a cada comisionista, y conciliar
sus facturas con los documentos de pago para cumplimiento ante el SAT. Ver el
detalle completo del objetivo en [`Datos/Comisiones_DBC_Borrador_Tecnico.md`](./Datos/Comisiones_DBC_Borrador_Tecnico.md).

Repo independiente (no vive dentro de otro monorepo). **Nace como derivado de
`proan-hidrocarburos`** (que a su vez viene de `proan-maka-rentabilidad`/Maka,
recortado), y mantiene su misma estructura tipo monorepo — sin auth-service,
sin gateway, sin Postgres:

```
apps/comisionesbi   backend FastAPI (BigQuery)
apps/frontend       frontend Next.js 14 (Comisiones DBC, estética Proan)
deploy/cloudrun     despliegue de producción (Cloud Run, un servicio con 2 contenedores)
deploy/             docker-compose.dev.yml + nginx (solo desarrollo)
config/             comisionesbi.env + bq_credentials.json (BigQuery)
Datos/              borrador técnico del mapeo de datos y la arquitectura
pyproject.toml      workspace uv (miembro: apps/comisionesbi) + uv.lock
LOGIN.md            decisiones de login y roles (provisional)
```

- **Backend**: endpoints `/v1/comisionesbi/{catalog,report,reconciliation}`.
  Hoy solo `catalog` funciona de verdad (división + CEDIS, ya resueltos); `report`
  y `reconciliation` devuelven 501 explícito — ver por qué en
  `apps/comisionesbi/comisionesbi/{comisiones,conciliacion}_engine.py`.
- **Frontend**: login Google (Firebase) + usuario/contraseña (`.htpasswd`),
  igual que Hidrocarburos — ver [`LOGIN.md`](./LOGIN.md). Tres módulos de
  navegación: `/flujo-producto` (catálogo división/CEDIS, con datos reales),
  `/comisiones` y `/conciliacion` (estas dos ya llaman de verdad a su
  endpoint, pero como el motor está bloqueado devuelven 501 y la pantalla cae
  a una vista previa con datos de ejemplo, claramente marcada como tal).

## Estado actual (agosto 2026)

Este repo es, por ahora, **el esqueleto de la aplicación**, no la aplicación
terminada. El trabajo hecho hasta ahora es sobre todo de mapeo de datos y
diseño de arquitectura — ver `Datos/Comisiones_DBC_Borrador_Tecnico.md` para
el detalle completo (dimensiones resueltas, modelo de 4 capas, tarifas de
comisión derivadas empíricamente, pendientes y preguntas para el cliente).

**Bloqueantes para construir el módulo de comisión real:**

1. Export de GS03 (definición de SETs de producto por división) — sin esto no
   se puede agrupar `material_number` por marca/línea.
2. Tabla oficial de tarifas de comisión (TX `ZSDFI_001`).
3. Relación comisionista ↔ oficinas de venta.
4. Rango de proveedor de comisionistas + frecuencia de liquidación.

Sin (1) y (2), el endpoint `/v1/comisionesbi/report` no se puede construir de
verdad — devuelve 501 a propósito en vez de simular datos. El módulo de
conciliación documental (`reconciliation`) está igual de bloqueado, más el
hecho de que casi no se ha explorado la fuente (`FBL1N` / `sap_bsik_open_items`).

Lo que **sí** funciona hoy: el catálogo de división + CEDIS (`/v1/comisionesbi/catalog`),
y todo el armazón de la app (login, shell autenticado, despliegue).

## Levantar en local (desarrollo)

Requisitos: Docker Desktop. Desde la raíz de este repo:

1. **Credenciales BigQuery** — service-account (lectura sobre `proan-quantrue`) en:

   ```
   config/bq_credentials.json
   ```

2. **Usuarios técnicos** — copia la plantilla y genera tu propio hash (ver
   comentarios dentro del fichero):

   ```bash
   cp deploy/nginx/.htpasswd.example deploy/nginx/.htpasswd
   ```

3. **Arrancar**

   ```bash
   docker compose -f deploy/docker-compose.dev.yml up --build
   ```

4. Abre **http://localhost:8080**.

## Producción / despliegue

**Cloud Run**, con `bash deploy/cloudrun/deploy.sh`. Ver
[`deploy/cloudrun/README.md`](./deploy/cloudrun/README.md) para la preparación
(secretos, app de Firebase) y el detalle. Mismo patrón que `proan-hidrocarburos`:
un solo servicio con dos contenedores (frontend de entrada, `comisionesbi` como
sidecar sin URL pública).

## Dependencias del backend (uv)

Workspace uv: `pyproject.toml` + `uv.lock` en la raíz. Tras cambiar
dependencias en `apps/comisionesbi/pyproject.toml`, regenera el lock:

```bash
docker run --rm -v "${PWD}:/w" -w /w ghcr.io/astral-sh/uv:latest uv lock
```
