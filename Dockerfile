# syntax=docker/dockerfile:1
# Build on / for linux/amd64 (the Pikafish release used here only ships an x86-64 Linux binary).
# On Apple Silicon: docker build --platform linux/amd64 .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/ shared/
RUN npm ci

# Server bundle -> /app/dist (the vendored shared engine is bundled in).
FROM deps AS build
COPY . .
RUN npm run build

# Pikafish binary + NNUE network, pinned and checksum-verified by the script.
FROM node:22-bookworm-slim AS engine
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates p7zip-full \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-pikafish.sh /fetch-pikafish.sh
RUN /fetch-pikafish.sh /engine

# Runtime dependencies only.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/ shared/
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3001 \
    PIKAFISH_PATH=/app/engine/pikafish \
    PIKAFISH_EVAL=/app/engine/pikafish.nnue
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY --from=engine /engine ./engine
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
