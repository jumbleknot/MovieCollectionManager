# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Installs all deps and runs expo export to produce the server bundle.
FROM node:24.14.1-alpine3.23 AS builder

# glibc compatibility — required by some native Node modules (ioredis, etc.)
RUN apk add --no-cache gcompat

WORKDIR /app

# Install all dependencies (including devDeps needed for the Expo/Metro build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source files
COPY . .

# Bake web build-time env vars.
# EXPO_PUBLIC_BFF_BASE_URL is intentionally empty — the web client uses
# relative URLs when served from the same origin as the BFF.
ARG EXPO_PUBLIC_BFF_BASE_URL=""
ENV EXPO_PUBLIC_BFF_BASE_URL=$EXPO_PUBLIC_BFF_BASE_URL

# Generate the Expo Router server bundle into dist/
RUN npx expo export --platform web

# ── Stage 2: Production runtime ───────────────────────────────────────────────
# Lean image with only production deps + the built output.
FROM node:24.14.1-alpine3.23 AS runner

RUN apk add --no-cache gcompat

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Express adapter entry point
COPY server.js ./

# Built Expo Router output (client assets + server functions)
COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
