# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Installs all deps and runs expo export to produce the server bundle.
# Build context must be the monorepo root:
#   docker build -t mcm-bff:latest -f frontend/mcm-app/Dockerfile .
FROM node:24.14.1-alpine3.23 AS builder

# glibc compatibility — required by some native Node modules (ioredis, etc.)
RUN apk add --no-cache gcompat

# Enable corepack so pnpm is available without a separate install step
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

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

# ── Stage 2: Production dependency tree ───────────────────────────────────────
# Resolves the workspace and materializes a standalone PRODUCTION tree at
# /app/runtime. This is its own stage rather than part of the runner because the
# work leaves ~2 GB of build-only residue behind that the runtime never touches:
# the full workspace install at /app/node_modules (1.6 GB — devDeps included,
# because pnpm resolves the whole graph before --prod filters it) plus pnpm's
# content-addressable store under /root (~390 MB). Done in the runner, all of
# that is baked into the shipped image; done here, only /app/runtime is copied
# out. Measured 2026-08-27: 4.56 GB → ~1.4 GB.
#
# It also keeps this layer keyed on the manifests and lockfile alone, so editing
# app source does not re-run the 1.2 GB deploy — which matters because the build
# cache competes for the same constrained disk as the images (item #246).
FROM node:24.14.1-alpine3.23 AS deps

# glibc compatibility — required by some native Node modules (ioredis, etc.)
RUN apk add --no-cache gcompat

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /app

# Copy workspace manifests so pnpm can resolve the workspace graph.
# The design-system source is copied in full (not just its manifest) because
# pnpm deploy --prod materializes @mcm/design-system into the standalone
# node_modules (feature 015).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/mcm-app/package.json ./frontend/mcm-app/
# server.js and its plain-CommonJS security-header builder (feature 032) are
# copied into the PACKAGE directory, not the image root: `pnpm deploy` carries
# the package's own files across, which is how they arrive at /app/runtime.
COPY frontend/mcm-app/server.js ./frontend/mcm-app/
COPY frontend/mcm-app/web-security-headers.js ./frontend/mcm-app/
COPY packages/design-system/ ./packages/design-system/

# npm stays intact in THIS stage: the root package.json preinstall runs
# `npx --yes only-allow pnpm`, so npx must exist for the install to succeed. The
# CVE removal belongs in the runner, which is the stage that actually ships.
RUN pnpm install --frozen-lockfile && \
    pnpm deploy --filter=mcm-app --prod --legacy /app/runtime

# ── Stage 3: Production runtime ───────────────────────────────────────────────
# Receives artifacts only. No package manager runs here and none is needed —
# the runtime is `node server.js`.
FROM node:24.14.1-alpine3.23 AS runner

# Three things in one layer, all of which must precede the COPYs below:
#   • gcompat — glibc compatibility for native Node modules (ioredis, etc.).
#   • Remove the bundled npm. It ships its own `tar` < 7.5.19, carrying the
#     fixable CRITICAL CVE-2026-59873 (node-tar gzip-bomb DoS) that fails the
#     cd-deploy Trivy gate (`--severity CRITICAL --ignore-unfixed`). Removing it
#     eliminates the vulnerable code outright — a real fix, not a suppression.
#     node:24-latest still ships npm with tar < 7.5.19, so a base bump does not
#     clear this; remove until the upstream manager carries the fix. The pnpm
#     half of the old removal is now structural: corepack is never activated in
#     this stage, so no pnpm dist is ever downloaded to /root/.cache.
#   • Create mcm, so the COPYs below can set ownership as they write.
RUN apk add --no-cache gcompat && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup -S mcm && adduser -S mcm -G mcm

# --chown on the COPY, never `chown -R` afterwards. A layer records a whole
# changed file rather than a metadata delta, so re-owning the tree in a separate
# RUN stored a second full copy of it — a 1.33 GB layer contributing no new
# content, and enough to fail `exporting layers` on a full disk (item #244).
#
# WORKDIR comes AFTER these, and both destinations are absolute: WORKDIR creates
# the directory as root, and --chown then applies only to what is copied INTO an
# already-existing destination. Setting the workdir first left /app/runtime
# itself owned by root — measured, and a real behavioural difference from the
# chown -R it replaces, not a cosmetic one.
COPY --from=deps    --chown=mcm:mcm /app/runtime         /app/runtime
COPY --from=builder --chown=mcm:mcm /app/standalone/dist /app/runtime/dist

WORKDIR /app/runtime

# Drop to a non-root user before running the server (defense-in-depth; feature
# 034). The server only reads /app/runtime and logs to stdout — no writable
# runtime path needed.
USER mcm

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
