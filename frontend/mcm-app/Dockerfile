# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Installs all deps and runs expo export to produce the server bundle.
# Build context must be the monorepo root:
#   docker build -t mcm-bff:latest -f frontend/mcm-app/Dockerfile .
FROM node:24.14.1-alpine3.23 AS builder

# glibc compatibility — required by some native Node modules (ioredis, etc.)
RUN apk add --no-cache gcompat

# Enable corepack so pnpm is available without a separate install step
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace manifests and lockfile so pnpm can resolve all deps.
# @mcm/design-system (packages/*) is a workspace dependency of mcm-app — its
# manifest must be present or pnpm install --frozen-lockfile fails with
# ERR_PNPM_WORKSPACE_PKG_NOT_FOUND (feature 015).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/mcm-app/package.json ./frontend/mcm-app/
COPY packages/design-system/package.json ./packages/design-system/

# Install all dependencies (including devDeps needed for the Expo/Metro build)
RUN pnpm install --frozen-lockfile

# Copy the app source + the design-system source (consumed as TS source —
# its package main is index.ts; Metro/expo export transpiles it directly).
COPY frontend/mcm-app/ ./frontend/mcm-app/
COPY packages/design-system/ ./packages/design-system/

# pnpm workspace symlinks break inside Docker — the virtual store's symlinks
# resolve to host paths that don't exist in the container. pnpm deploy creates
# a standalone directory with a flat node_modules (no symlinks) that works
# correctly inside the container.
RUN pnpm deploy --filter=mcm-app --legacy /app/standalone

WORKDIR /app/standalone

# Bake web build-time env vars.
# EXPO_PUBLIC_BFF_BASE_URL is intentionally empty — the web client uses
# relative URLs when served from the same origin as the BFF.
ARG EXPO_PUBLIC_BFF_BASE_URL=""
ENV EXPO_PUBLIC_BFF_BASE_URL=$EXPO_PUBLIC_BFF_BASE_URL

# The browser performs the OAuth authorize redirect, so the public Keycloak host must be inlined into
# the web bundle here (Metro only inlines EXPO_PUBLIC_*). Prod passes https://auth.<BASE_DOMAIN>; when
# empty (local/dev/CI) the client falls back to KEYCLOAK_URL / the localhost:8099 default.
ARG EXPO_PUBLIC_KEYCLOAK_URL=""
ENV EXPO_PUBLIC_KEYCLOAK_URL=$EXPO_PUBLIC_KEYCLOAK_URL

# Generate the Expo Router server bundle into dist/
RUN npx expo export --platform web

# ── Stage 2: Production runtime ───────────────────────────────────────────────
# Lean image with only production deps + the built output.
FROM node:24.14.1-alpine3.23 AS runner

RUN apk add --no-cache gcompat

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace manifests so pnpm can resolve the workspace graph.
# The design-system source is copied in full (not just its manifest) because
# pnpm deploy --prod materializes @mcm/design-system into the standalone
# node_modules (feature 015).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/mcm-app/package.json ./frontend/mcm-app/
COPY frontend/mcm-app/server.js ./frontend/mcm-app/
# Feature 032: the plain-CommonJS security-header builder required by server.js at boot.
COPY frontend/mcm-app/web-security-headers.js ./frontend/mcm-app/
COPY packages/design-system/ ./packages/design-system/

# Install workspace deps, then deploy production-only to a standalone directory
RUN pnpm install --frozen-lockfile && \
    pnpm deploy --filter=mcm-app --prod --legacy /app/runtime

WORKDIR /app/runtime

# Built Expo Router output (client assets + server functions)
COPY --from=builder /app/standalone/dist ./dist

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
