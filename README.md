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
data/               notas de datos (hallazgos fechados) y SQL de silver/gold
pyproject.toml      workspace uv (miembro: apps/comisionesbi) + uv.lock
LOGIN.md            decisiones de login y roles (provisional)
```

- **Backend**: endpoints `/v1/comisionesbi/{catalog,flujo,report,reconciliation}`.
  `catalog` (división + CEDIS) y `flujo` funcionan de verdad, este último sobre
  la tabla gold diaria; `report` y `reconciliation` devuelven 501 explícito —
  ver por qué en `apps/comisionesbi/comisionesbi/{comisiones,conciliacion}_engine.py`.
- **Frontend**: login Google (Firebase) + usuario/contraseña (`.htpasswd`),
  igual que Hidrocarburos — ver [`LOGIN.md`](./LOGIN.md). Cuatro entradas de
  navegación: `/manual` (manual de usuario, abre la barra), `/flujo-producto`
  (la pantalla del módulo 0, con datos reales) y `/comisiones` y
  `/conciliacion` (estas dos ya llaman de verdad a su endpoint, pero como el
  motor está bloqueado devuelven 501 y la pantalla cae a una vista previa con
  datos de ejemplo, claramente marcada como tal).

## Estado actual (agosto 2026)

**El módulo 0 (flujo de producto) funciona con datos reales**, con las tres
capas que están resueltas: vendido, facturado y cobrado por CEDIS, división,
tipo de venta, mes y unidad, con serie diaria en barras agrupadas (tres por día,
que pasan a semana o mes cuando el rango no cabe). Se filtra pulsando sobre las
propias gráficas y el filtro viaja en la URL, así que una vista se comparte por
enlace. **Las tres fases traen ya cantidad en cajas**, así que el embudo se
puede leer en producto y no solo en dinero. Falta la primera capa, los
traspasos, aunque el cliente ya dio el código de movimiento (BWART 300-399, y
100-199 en croqueta) y sale marcada como pendiente en el manual.

La pantalla **no enseña todo lo que factura DBC**, y el manual lo explica en su
primer apartado: solo las cinco divisiones que el cliente opera (huevo, botana,
croqueta, abarrotes y leche) y sin los cuatro almacenes centrales, que no
pertenecen a ningún CEDIS. Con eso, el importe **sin CEDIS asignado pasó del 65%
al 0,2%** — no por un mapeo mejor, sino porque dos tercios de aquel hueco nunca
fueron un hueco, y el tercio que sí lo era se cerró con la lista de almacenes que
mandó el cliente. Ver `data/notas/tablas_del_cliente.md`.

El hallazgo incómodo que sigue **a la vista en la interfaz** es el retraso de
`sap_VBAP`: la serie de «vendido» termina antes que las otras dos en vez de caer
a cero. Ver `data/notas/hallazgos.md`.

Hay además un **manual de usuario** en `/manual`, escrito para que nadie saque
conclusiones falsas de esta pantalla: qué resuelve la plataforma, el recorrido
del producto en cuatro capas con la tabla de SAP de la que sale cada una, y las
tres trampas de la pantalla explicadas con demos interactivas.

Los **módulos de comisión y conciliación siguen bloqueados**, y no por falta de
SQL: son datos que solo tiene el cliente. El resto del mapeo está en
`Datos/Comisiones_DBC_Borrador_Tecnico.md` y `data/Resumen.md` (dimensiones
resueltas, modelo de 4 capas, tarifas derivadas empíricamente, pendientes).

**Bloqueantes para el módulo de comisión — cuatro de cinco cayeron el 24 y 25
de agosto de 2026, cuando el cliente mandó sus tablas** (ver
`data/notas/tablas_del_cliente.md`; el extractor es `scripts/tablas_cliente.py`
y deja cinco diccionarios en `ZZ_PRUEBAS.DBC_dim_*`):

1. ~~Export de GS03 (SETs de producto)~~ — **resuelto**: cubre el 94,3% del
   facturado en operación. Falta solo asignar los tres materiales de leche.
2. ~~Tabla oficial de tarifas~~ — **resuelto**: 3.426 tarifas. Y no hay un solo
   modelo: huevo, botana, croqueta y leche van por importe unitario sobre una
   matriz SET × tipo de venta, mientras abarrotes va por margen sobre el precio
   de cada material. La base de huevo es el **kilo**, no la caja.
3. ~~Relación comisionista ↔ oficinas~~ — **resuelto**: 57 nombres de
   comisionista, de los que 32 traen código de persona (esa brecha hay que
   cerrarla antes de liquidar a nadie). Además destraban conciliación: no había
   maestro de proveedores en BigQuery.
4. Rango de proveedor de comisionistas + frecuencia de liquidación.
5. ~~Código `BWART` de traspasos~~ — **resuelto**: 300-399, y 100-199 en
   croqueta. Falta entender el reparto entre `sap_mseg`, `sap_mseg_cerdo` y
   `sap_mseg_croqueta` antes de construir la cuarta capa.

Sigue abierto: qué hoja de tarifas de botana está vigente (sus dos versiones
difieren en 619 de 624 casillas).

Sin (1) y (2), el endpoint `/v1/comisionesbi/report` no se puede construir de
verdad — devuelve 501 a propósito en vez de simular datos. El módulo de
conciliación documental (`reconciliation`) está igual de bloqueado, más el
hecho de que casi no se ha explorado la fuente (`FBL1N` / `sap_bsik_open_items`).

Lo que **sí** funciona hoy: el catálogo (`/v1/comisionesbi/catalog`), el flujo de
producto (`/v1/comisionesbi/flujo`) con su pantalla y su manual, y todo el
armazón de la app (login Google + técnico, shell autenticado, despliegue).

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

`app/`, `src/`, `client.config.ts` y `next.config.mjs` van montados, así que
editar componentes o estilos recompila solo. Tocar `package.json`, el
`Dockerfile` o el `tsconfig.json` sí pide `--build`.

### Sin Docker (solo el frontend)

Se puede levantar el frontend a pelo, pero **hay que darle el entorno a mano**:
las variables que en Docker pone `docker-compose.dev.yml` no existen fuera, y
sin las tres de Firebase el botón de Google no se pinta (la pantalla se repliega
al usuario/contraseña, que es el comportamiento previsto cuando no hay Firebase
configurado).

```bash
cd apps/frontend
cp .env.local.example .env.local   # ya trae los valores de desarrollo
pnpm dev
```

Las pantallas de datos necesitan además el backend en `localhost:8091`; sin él
enseñan su error y el login sigue funcionando igual.

**No lances `next build` con el servidor de desarrollo levantado**: los dos
escriben en `.next` y el build le sobrescribe los manifiestos, con lo que la
página se queda sin CSS y sin ningún error a la vista. Para eso está
`NEXT_DIST_DIR` (ver `next.config.mjs`):

```bash
NEXT_DIST_DIR=.next-check pnpm build
```

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
