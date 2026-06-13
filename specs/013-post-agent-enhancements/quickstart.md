# Quickstart: Post-Agent Enhancements

**Feature**: 013-post-agent-enhancements | **Date**: 2026-06-11

How to bring up the stack and verify each of the six items. All commands run from repo root via Nx (PowerShell shell). RTK must be active (`rtk gain` >80%).

## Bring-up

```powershell
# Backend + Keycloak + Redis + Mongo (replica set)
pnpm nx up-all infrastructure-as-code

# Frontend (Metro) for iterative dev
cd frontend/mcm-app; pnpm start    # press w for web

# Agent stack (only for items 3–6): host gateway on 127.0.0.1:8123 with production MCP nodes,
# or containerized: see CLAUDE.md "Containerized agent E2E" (nx up-agents-prod + e2e:agents).
```

mc-service must be rebuilt + redeployed after Rust changes before any E2E (stale image = meaningless run):

```powershell
pnpm nx build mc-service
docker compose --profile app up -d --force-recreate mc-service
```

## Item 1 — Collection movie sort (mc-service + frontend)

```powershell
# Unit: cursor encode/decode + keyset boundary, sort-param validation
pnpm nx test mc-service -- --test movie_repository
# Integration (real Mongo): paginate fully across a non-default sort; assert order + no dup/skip
pnpm nx test:integration mc-service
# Frontend unit: use-movies sort state threads sortBy/sortDir; resets cursor on sort change
pnpm nx test mcm-app -- --testPathPattern use-movies
# Web E2E: default title→year on open; change sort re-orders; sort persists across filter change/clear
pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts
# Mobile E2E
maestro test tests/e2e/mobile/movie-sort.yaml --env E2E_TEST_USER=… --env E2E_TEST_PASSWORD=…
```

Manual check (curl/Invoke-RestMethod against mc-service): `?sortBy=year&sortDir=desc` orders desc; `?sortBy=bogus` → 400.

## Item 2 — Count info line (BFF + frontend)

```powershell
# BFF integration (real mc-service): GET …/movies/count honours filter; route-coverage map updated
pnpm nx test:integration mcm-app -- --testPathPattern movies-count
# Frontend unit: count line shows total unfiltered; filtered/total when filtered; updates after add/delete
pnpm nx test mcm-app -- --testPathPattern movie-count-line
# Web E2E: open → total; filter → M/N; add/delete → count updates; clear filter → total
pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts
```

## Item 3 — Clickable assistant movie card (agent + frontend)

```powershell
# Agent unit: render_movie_card carries movie_id + collection_id on the found path
pnpm nx test movie-assistant
# Frontend unit: card is pressable iff both ids present → pushes detail route
pnpm nx test mcm-app -- --testPathPattern render-movie-card
# Web E2E (navigate IN-APP, never deep-load before driving the dock — R15):
#   ask about an in-collection movie → tap card → assert on movie-detail screen
pnpm nx e2e mcm-app -- tests/e2e/web/agent-card-navigate.spec.ts
```

## Item 4 — Disambiguation buttons (agent + frontend)

```powershell
# Agent unit: curator emits render_disambiguation when awaiting_pick; resolve_option unchanged
pnpm nx test movie-assistant
# Golden replay MUST stay green (no model-decision change):
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
# Frontend unit: ≤5 buttons + overflow; tap posts canonical disambiguator text
pnpm nx test mcm-app -- --testPathPattern disambiguation-options
# Web E2E: ambiguous look-up → buttons → tap → assistant proceeds with that match
pnpm nx e2e mcm-app -- tests/e2e/web/agent-disambiguation.spec.ts
```

## Item 5 — TMDB external link (agent)

```powershell
# Agent unit: to_movie_payload sets externalIds[].url for tmdb; omits entry when no id
pnpm nx test movie-assistant -- -k to_movie_payload
# Integration (real MCP + real mc-service): scrape+add → movie has url https://www.themoviedb.org/movie/<id>
pnpm nx test:integration movie-assistant
# Web E2E: add via assistant → open detail → external link present + correct pattern
```

## Item 6 — Navigate to a movie (agent)

```powershell
# Agent unit: navigator resolves a movie across collections; one→navigate, many→clarify, none→not found
pnpm nx test movie-assistant
# Golden replay: green if intent prompt unchanged; re-record (delete stale first) ONLY if it changed —
#   record on BOTH qwen2.5 (runtime) and Claude (gate)
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
# Web E2E: "take me to <movie>" → movie-detail; ambiguous → clarifying prompt
pnpm nx e2e mcm-app -- tests/e2e/web/agent-navigate-movie.spec.ts
```

## Final validation (per CLAUDE.md checklist)

```powershell
pnpm nx test mc-service ; pnpm nx test:integration mc-service
pnpm nx lint mcm-app ; pnpm nx test mcm-app ; pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app                       # REQUIRED for every feature (rebuild/redeploy changed containers first)
pnpm nx e2e:mobile mcm-app
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
rtk gain                                  # >80% compression
```

## Gotchas (carried from 012)

- Restart/redeploy the gateway from source before agent E2E (a running `:8123` may be stale).
- Run agent E2E specs **isolated per file** (parallel runs trip per-user rate-limit + ~5-min token expiry).
- mc-service requires Keycloak (JWKS on startup) and a **replica-set** Mongo (transactions).
- After Rust changes, rebuild + recreate the mc-service container before E2E, or you validate a stale image.
