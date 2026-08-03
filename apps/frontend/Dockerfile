# Dockerfile de DESARROLLO del frontend (Next.js 14, App Router).
#
# Contexto de build: RAÍZ del repo (como en Maka), rutas apps/frontend/...
# En dev el código se sobre-monta con bind mounts (ver deploy/docker-compose.dev.yml),
# así que `next dev` recompila en caliente; la imagen solo aporta node_modules.
FROM node:20-alpine

WORKDIR /app/apps/frontend

RUN corepack enable

# Deps primero (capa cacheable). --no-frozen-lockfile: el pnpm-lock.yaml puede
# ir por detrás de package.json (p.ej. bcryptjs recién añadido).
COPY apps/frontend/package.json apps/frontend/pnpm-lock.yaml ./
RUN corepack pnpm install --no-frozen-lockfile

COPY apps/frontend/app ./app
COPY apps/frontend/src ./src
COPY apps/frontend/client.config.ts ./client.config.ts
COPY apps/frontend/next.config.mjs ./next.config.mjs
COPY apps/frontend/tsconfig.json ./tsconfig.json
COPY apps/frontend/next-env.d.ts ./next-env.d.ts
COPY apps/frontend/.eslintrc.json ./.eslintrc.json

EXPOSE 3000

CMD ["corepack", "pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
