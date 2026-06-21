# Feature 020 — Docker Compose Stack & Container Naming Cleanup — HANDOFF

**Status: IMPLEMENTED + LIVE-VERIFIED. Committed on branch `020-docker-stack-naming`. NOT merged to `main`, no PR yet.**

Read first: this file → `spec.md` / `plan.md` / `data-model.md` (authoritative rename map) → `discovery-notes.md` (change list + final validation results) → the auto-memory `project_mcm_020_docker_stack_naming.md`.

## Git state

- Branch `020-docker-stack-naming`, working tree **clean** (everything committed).
- Commits past the SDD baseline `0e70c28`: `24e0b47` analyze → `27cd5f9` first round of implement → `46bb136` fixes → `c02b0c2` another fix.
- `tasks.md`: all 33 tasks marked `[X]` (T004 intentionally unused).

## What shipped

- **US1 — unified identifiers**: every service's `container_name` AND compose **service key** unified to one `<component>[-<role>-<technology>]` id across the 11 per-service compose files; every in-lockstep reference updated (`depends_on`, env connection URLs, Caddyfile upstream, rs member host, scripts, CI, app config, the **gitignored** `.env.docker`/`.env.local`, env examples). Volume KEYS also unified to their external names (external `name:` unchanged → SC-007 safe).
- **US2 — four stacks**: `infrastructure-as-code/docker/stacks/{auth,mcm,audit,observability}.compose.yaml` (each its own Compose project, `include:`-only). Vault relocated observability→auth (`infrastructure-as-code/docker/vault/compose.yaml`, `vault` profile). Root `compose.yaml` **retired** to a pointer comment. Nx targets remapped: `up-auth/up-mcm/up-audit/up-observability/up-all` + `down-*` (+ `up-mcm-agents`, see below).
- **US3 — enforced + documented**: `scripts/check-resource-naming.mjs` now asserts `container_name == service key == convention` + Rule 4 (no retired key as a network alias) + Rule 3/3b allowlists (`langfuse-*`, `otel-lgtm`, `keycloak-mailpit`, `unleash-postgres`, `unleash-seed`). CI workflows (`naming-gate.yml`, `android-e2e.yml`) updated. CLAUDE.md, `docs/runbooks/{local-dev,e2e-testing}.md`, `docs/MCM-Architecture.md`, `frontend/mcm-app/README.md`, and the auto-memory brought to the new model.

## Post-implementation fixes (this session, all committed)

1. **Agent layer was down after the US2 isolation test** — I had removed the standalone agent containers during T027 and not restored them. Restored, then **switched from `agent-stack.mjs` (light: `docker run` + MemorySaver, no postgres) to the mcm compose stack `--profile agents`** (heavy: project `mcm` + `movie-assistant-store-postgres` checkpointer), which is what the user wanted.
2. **`spreadsheet-mcp/compose.yaml`** — added `mcm-bff-network` so it reaches `mcm-bff-cache-redis` (which lives on mcm-bff-network, NOT backend-network). Makes `--profile agents` self-sufficient; previously `agent-stack.mjs` runtime-`docker network connect`-ed it.
3. **New `up-mcm-agents` Nx target** (`scripts/up-mcm-agents.mjs`) — fetches the agent-gateway Keycloak client secret and brings up `--profile agents` in one step (the secret is required for tool calls; no committed source).
4. **Retired `movie-assistant-gw-proxy`** — the socat host-bridge in `agent-stack.mjs` is removed. Host `:8123` access (for a Metro/host BFF or the `agent-config-run-revoked` integration test) is now the stack-native `--profile agents-metro` (the gateway publishes `127.0.0.1:8123` itself via `movie-assistant-gateway-metro`).

## Validation (all green)

Gate RED (13 violations) → GREEN; gate-fail test FAILs on mismatch / PASS on revert (SC-005). Web E2E dev-container: 126 passed (the lone failure was preserved-Mongo fixture contamination → 12/12 filter + 19/19 collections green on reseed; SC-002/FR-014). mc-service integration: **116 passed, 0 failed** (rs transactions survive the mongo rename). Four-stack isolation proven (down one, others survive — SC-004). Vault profile gating proven (FR-008). FR-011 image tag unchanged. SC-007: 4 networks + 7 named volumes byte-for-byte unchanged. Agent layer verified end-to-end: gateway `/health` ok, production nodes ON, all 3 MCP reachable (200), BFF→gateway ok, postgres checkpointer wired. Full results in `discovery-notes.md`.

## Current running stack (this machine)

Projects: `auth` (keycloak trio + `vault-service`), `mcm` (`--profile app --profile bff-nonsecure --profile agents`: mc-service + stores + BFF + gateway + 3 MCP + `movie-assistant-store-postgres`). Host Ollama serving qwen2.5.

## Open items / next steps

- **Merge**: open a PR for `020-docker-stack-naming` → `main` (not done). Consider `/code-review ultra` first.
- **Final full-suite gate** (per CLAUDE.md Final Validation Checklist) before merge: `pnpm nx lint mcm-app`, `pnpm nx test mcm-app`, the full web E2E, and mobile (CI-only, issue #16). The web E2E + mc-service integration were run green this session; lint/unit not re-run after the last doc edits.
- **`--profile agents-metro` not live-tested** after the gw-proxy retirement — it was reasoned-correct (the `movie-assistant-gateway-metro` service publishes `127.0.0.1:8123:8000`) but not started this session. If the next session runs the Metro/host-BFF path or the `agent-config-run-revoked` integration test, bring it up and confirm `:8123` is reachable.
- **SC-003 caveat**: the pre-change E2E run-time baseline was recorded after edits began (T002 jumped ahead), so the ≤10% comparison uses the documented historical baseline, not a true same-session before/after. No connectivity-retry slowdown occurred. Noted in `discovery-notes.md`.

## Key gotchas for the next session (also in the auto-memory)

- **Two agent bring-up variants — don't confuse them.** `scripts/agent-stack.mjs` (`nx up-agents-prod`) = LIGHT E2E (`docker run`, MemorySaver, **no** postgres, standalone — not under any compose project). The mcm stack `--profile agents` (`nx up-mcm-agents`) = HEAVY (compose project `mcm`, postgres checkpointer). For "agents under the stack" use `up-mcm-agents`.
- **`--profile agents` needs `AGENT_GATEWAY_CLIENT_SECRET`** (Keycloak client secret, no committed source) or tool calls fail-closed; `up-mcm-agents` fetches it. Also needs host Ollama (the compose gateway is ollama-only) + `auth` + `mcm app` up first.
- **`container_name` is host-unique** → can't `up` a stack while an old single-project container with that name still runs. Clean-slate: `docker ps -aq --filter label=com.docker.compose.project=mcm | xargs docker rm -f`.
- **BFF reads `.env.docker` via `env_file` at container CREATE** (not baked in image) → gitignored-env hostname edits apply on recreate, no rebuild needed. The 3 critical live hosts: `KEYCLOAK_URL=keycloak-service`, `REDIS_URL=mcm-bff-cache-redis`, `MONGO_URL=mcm-bff-store-mongo`.
- **Keycloak client IDs** (`mcm-bff-service`, `mcm-bff-test`, `agent-gateway`, `agent-subject-token`) and **image tags** (`movie-mcp:latest`, etc.) are NOT service/DNS names — never rename them.
- **web-E2E exact-count filter flake** = preserved-Mongo fixture contamination, NOT a connectivity regression (globalSetup reseed → green). Diagnose as a real regression first (deterministic dev-container baseline) before blaming the environment.
