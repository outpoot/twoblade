# syntax = docker/dockerfile:1

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim AS base-node
WORKDIR /app
ENV NODE_ENV="production"

FROM base-node AS build-main

ARG PUBLIC_DOMAIN
ARG PUBLIC_WEBSOCKET_URL
ARG DATABASE_URL
ARG JWT_SECRET
ARG PRIVATE_B2_KEY_ID
ARG PRIVATE_B2_APP_KEY
ARG PRIVATE_B2_BUCKET
ARG PRIVATE_B2_REGION
ARG PRIVATE_B2_ENDPOINT
ARG TEST_AUTH_TOKEN
ARG REDIS_URL
ARG PUBLIC_TURNSTILE_SITE_KEY

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    build-essential \
    node-gyp \
    pkg-config \
    python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

COPY website/package.json website/package-lock.json* ./

RUN npm ci --include=dev

RUN mkdir -p "./websocket/src" && cat >"./websocket/src/moderation.ts" <<EOF
// Moderation service for websocket connections
// Created by Dockerfile

export function checkHardcore(msg: string): boolean {
    // Placeholder implementation - should be replaced with actual detection
    return false;
}
EOF

COPY website/. ./

RUN npm run build

RUN npm prune --omit=dev

FROM base-node AS build-websocket
WORKDIR /app/websocket

RUN mkdir -p "/app/websocket/src" && cat >"/app/websocket/src/moderation.ts" <<EOF
// Moderation service for websocket connections
// Created by Dockerfile

export function checkHardcore(msg: string): boolean {
    // Placeholder implementation - should be replaced with actual detection
    return false;
}
EOF

COPY website/websocket/package.json ./
COPY website/websocket/tsconfig.json ./
COPY website/websocket/src ./src/

RUN npm install
RUN npm install typescript @types/node clsx tailwind-merge

RUN npx tsc --project tsconfig.json

FROM base-node AS production-main

COPY --from=build-main --chown=node:node /app/build ./build
COPY --from=build-main --chown=node:node /app/node_modules ./node_modules
COPY --from=build-main --chown=node:node /app/package.json .

COPY --from=build-main --chown=node:node /app/cluster-server.js ./

USER node
EXPOSE 3000
CMD ["node", "cluster-server.js"]

FROM base-node AS production-websocket
WORKDIR /app/websocket

COPY --from=build-websocket /app/websocket/node_modules ./node_modules
COPY --from=build-websocket /app/websocket/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]