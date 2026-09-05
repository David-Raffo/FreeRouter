# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
# better-sqlite3 es nativo: si no hay prebuild para esta plataforma, necesita
# compilarse aquí. Por eso el builder trae toolchain y la imagen final no.
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Los manifiestos primero: mientras no cambien, la capa de dependencias se reutiliza.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

# Fuera las dependencias de desarrollo, conservando el binding nativo ya compilado.
RUN npm prune --omit=dev

# -------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    FREEROUTER_HOST=0.0.0.0 \
    FREEROUTER_HOME=/data \
    FREEROUTER_PORT=8787

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
# El catálogo es un dato editable, no código: viaja aparte de dist/.
COPY --from=build /app/server/catalog ./server/catalog
COPY --from=build /app/web/dist ./web/dist

# La base de datos y la clave maestra viven en un volumen, no en la imagen.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 8787

CMD ["node", "server/dist/index.js"]
