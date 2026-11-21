# Implementation Plan: Claude Code token usage capture and efficiency analysis

**Branch**: `105-cc-token-usage-capture` | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/105-cc-token-usage-capture/spec.md`; design rationale in
[docs/proposals/MCM-Claude-Code-Token-Usage-Proposal.md](../../docs/proposals/MCM-Claude-Code-Token-Usage-Proposal.md)

## Summary

Claude Code lifecycle hooks committed in `.claude/settings.json` run a zero-dependency Node script,
`scripts/cc-usage.mjs`, that reads only the new bytes of the session's JSONL transcripts on the
`mcm-claude` volume, reduces them to name/count/size records (never content), labels each turn by
activity, attributes each turn to a feature (any non-main branch, with or without a spec, resolved
from the worktree the turn worked in — so feature metrics are exact sums across every contributing
session), and upserts the records over HTTP to a new homelab stack, `prod-dev-usage` (Postgres +
PostgREST, upstream images, tailnet-only port 19040), authenticated by short-lived tokens that
Keycloak issues to a dedicated service-account client and the script caches until expiry. A `usage`
project skill fronts the same script
for in-session questions, a Grafana dashboard in the existing `otel-lgtm` reads the same views, and a
rules module turns per-activity baselines into findings tracked as experiments. Phase 0 measurement
([research.md](research.md)) confirmed the transcript fields, the duplicate-line behaviour, the
subagent file layout and the per-worktree project directories the design depends on.

## Technical Context

**Language/Version**: Node.js 26 (the dev container's baked toolchain, measured v26.13.1; ES modules, `node:` built-ins, global `fetch`) · SQL (PostgreSQL 18, as the other prod stacks)

**Primary Dependencies**: none at runtime in the container. Homelab: upstream `postgres:18` and `postgrest/postgrest` images pinned by digest. Reference oracle: ccusage at an exact version, run only by an on-demand target (research R8)

**Storage**: Postgres schema `usage` in the new `prod-dev-usage` stack ([data-model.md](data-model.md)); local state, spool and log under `$CLAUDE_CONFIG_DIR/usage/` on the persistent volume

**Testing**: `node --test` unit and guard tests under `scripts/__tests__/` (picked up by the CI glob `scripts/__tests__/*.test.mjs`); a store integration test against a real Postgres + PostgREST from `infrastructure-as-code/docker/dev-usage/compose.yaml`; no mocks of the store in the integration tier (constitution, Test Type Integrity)

**Target Platform**: the MCM dev container on the Docker Sandbox VM (Linux); the homelab host under Komodo (rootless Docker)

**Project Type**: developer tooling — a CLI script, a skill, and an infrastructure stack. No application code changes

**Performance Goals**: a `Stop` hook that does not ship exits in < 1 s (SC-005; precedent: an existing plugin Stop hook runs at p50 90 ms); `usage now` answers in < 5 s (SC-006); the first backfill of ~170 MB proceeds file by file without slowing the starting session

**Constraints**: hooks always exit 0 and print nothing; no content leaves the container; store URL, token-endpoint URL and client secret only from the environment (the cached token only in a 0600 file); at most one ship per session per 15 min plus one at session end; at most one sweep per container per 15 min; correct under concurrent sessions

**Scale/Scope**: one developer, ≤ 5 concurrent sessions, roughly 30–60 sessions and a few thousand turns a month; 172 MB of transcripts on the volume today

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing.*

| Principle | Status | How |
| --- | --- | --- |
| SDD gate (AGENTS.md) | Pass | Spec, plan and tasks precede any change under `infrastructure-as-code/` |
| Technology agnosticism in spec | Pass | Stack choices live only here and in research.md |
| Behavior-descriptive identifiers | Pass | `cc-usage.mjs`, `parse-transcript.mjs`, `label-activity.mjs`, `ship-records.mjs`; requirement ids only in comments |
| TDD (NON-NEGOTIABLE) | Pass | Every implementation task is preceded by a test task with Verify RED / Verify GREEN commands (`docs/templates/feature-test-tasks-template.md`) |
| Test Type Integrity | Pass | Unit tests use fixture transcripts and an injected `fetch`; the store contract is tested against a **real** Postgres + PostgREST; nothing in the integration tier mocks the store |
| Security: classification | Pass | Usage records are classified **internal** (spec Assumptions): tailnet-only, token-authenticated, no content |
| Security: secrets | Pass | The client secret via the `--env-file` path (`gen-container-secrets-env.sh`), stack secrets as Komodo Variables (ADR-0001); never in git, argv or logs; the cached token is 0600 and never logged |
| Security: authentication for internal data | Pass | Every request carries a Keycloak-issued OAuth2/OIDC access token (client-credentials grant, client `dev-usage-capture`), verified by PostgREST against the realm's JWKS (research R18). Changed from a self-signed JWT after `/speckit-analyze` finding C1 |
| Logging: structured, no sensitive data | Pass | `cc-usage.log` is JSON lines with UTC timestamp, level, service `cc-usage`, session id as correlation id; never the token, host names or content; size-capped and rotated |
| Logging: never degrade the host process | Pass | Every hook path exits 0; logging failures are swallowed |
| Docker-native ops | Pass | Upstream images, health checks, `restart: always`, json-file log rotation, a local `compose.yaml` beside `compose.prod.yaml` |
| Published-port reservation | Pass | 19040, inside 19000–19099, tailnet-only by host firewall |
| Backend-service principles (Rust, four-layer Clean Architecture, OpenAPI) | Not applicable | No first-party backend service is written; PostgREST is an upstream component whose interface is the SQL schema. The script still keeps pure modules (parse, label, rules) apart from IO (ship, state, http) |
| Package manager (pnpm only) | Pass | No dependency added to any lockfile; the oracle runs via `pnpm dlx` on demand |
| Nx as task runner | Pass | New targets on the `infrastructure-as-code` project: `cc-usage-oracle`, `dev-usage-integration` (names verified free) |
| Wiki same-PR refresh | Pass (tracked) | `published-port-reservation`, `prod-reboot-resilience`, `infrastructure-stacks`, `devcontainer`, `devcontainer-sandbox` and `repository` pages refreshed in the same PR (`secrets-management` cites ADR-0001, which is unchanged); the new runbook gets a concept page |
| Doc-impact sweep | Pass (tracked) | Run at `/speckit-tasks`; known terms: "three ports", the `VARS` list, the stack list, the naming-gate contexts |

## Project Structure

### Documentation (this feature)

```text
specs/105-cc-token-usage-capture/
├── plan.md              # This file
├── research.md          # Phase 0: measured transcript facts and decisions
├── data-model.md        # Phase 1: tables, views, labelling rules, state machines, local state
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── cli.md           # cc-usage.mjs commands, hook behaviour and invariants
│   ├── store-http.md    # PostgREST endpoints, upsert keys, forbidden operations, privacy shape
│   └── hooks-and-skill.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
.claude/
├── settings.json                         # + hooks block (SessionStart, Stop, SessionEnd)
└── skills/usage/SKILL.md                 # new project skill

scripts/
├── cc-usage.mjs                          # entry: hook + interactive commands
├── cc-usage-weights.json                 # dated token weight table
├── lib/cc-usage/
│   ├── parse-transcript.mjs              # pure: lines → model calls, turns, tool use, skills
│   ├── label-activity.mjs                # pure: ordered rules → one label per turn
│   ├── attribute-feature.mjs             # pure: turn paths + worktree map → feature or no-feature
│   ├── resolve-feature-identity.mjs      # branch → open feature id; reused names; reconciliation
│   ├── privacy-shape.mjs                 # pure: the allowlist of shippable fields
│   ├── efficiency-rules.mjs              # pure: baseline rows → findings
│   ├── local-state.mjs                   # offsets, atomic rename, sweep lock, spool claim, back-off
│   ├── ship-records.mjs                  # upsert batches over fetch; spool on failure
│   ├── obtain-access-token.mjs           # client-credentials grant; cached token; refresh near expiry
│   ├── collect-feature-outcomes.mjs      # git, tasks.md (spec features only), forge API
│   └── render-table.mjs                  # fixed-width output, host redaction
└── __tests__/
    ├── cc-usage-parse.test.mjs
    ├── cc-usage-label.test.mjs
    ├── cc-usage-feature-attribution.test.mjs  # worktree vs main checkout, split sessions, reused names, conservation
    ├── cc-usage-privacy.guard.test.mjs
    ├── cc-usage-concurrency.test.mjs
    ├── cc-usage-hook.guard.test.mjs       # exit 0, empty stdout, interval skip
    ├── cc-usage-oracle.test.mjs           # parser totals vs committed ccusage oracle
    ├── cc-usage-rules.test.mjs
    ├── cc-usage-settings.guard.test.mjs   # pins the hooks block
    ├── cc-usage-local-state.test.mjs      # offsets, locks, spool claim and cap, back-off
    ├── cc-usage-ship.test.mjs             # upsert protocol, spool on failure
    ├── cc-usage-token.test.mjs            # token acquisition, caching, refresh, failure modes
    ├── cc-usage-sweep.test.mjs            # all project dirs, backfill, stale sessions
    ├── cc-usage-doctor.test.mjs
    ├── cc-usage-render.test.mjs
    ├── cc-usage-query.test.mjs            # now, sessions, trend, compare, sync, tag
    ├── cc-usage-skill.guard.test.mjs
    ├── cc-usage-feature-identity.test.mjs
    ├── cc-usage-outcomes.test.mjs
    ├── cc-usage-feature-query.test.mjs
    ├── cc-usage-findings.test.mjs
    ├── cc-usage-statusline.test.mjs
    └── fixtures/cc-usage/                 # synthetic transcripts + ccusage-oracle.json

infrastructure-as-code/
├── docker/dev-usage/
│   ├── compose.yaml                      # local/integration: same services, ephemeral volume, CI Keycloak
│   ├── compose.prod.yaml                 # Komodo stack: postgres, schema-apply, jwks-fetch, postgrest (19040); backend-network
│   ├── schema/                           # ordered, IDEMPOTENT SQL applied on every deploy (research R19)
│   └── tests/store-contract.test.mjs     # integration: real Postgres + PostgREST + Keycloak-issued tokens
├── docker/keycloak/
│   ├── ci-realm.json, dev-realm.json, prod-realm.json   # + client dev-usage-capture (fresh realms)
├── docker/observability/
│   ├── compose.prod.yaml                 # + Grafana datasource/dashboard provisioning mount
│   └── grafana/                          # datasource (usage_reader role) + dashboard JSON
├── backup/backup.sh                      # + pg_dump of the dev-usage database
├── komodo/stacks.toml                    # + prod-dev-usage stack
└── project.json                          # + cc-usage-oracle, dev-usage-integration targets

.forgejo/workflows/app-ci.yml             # + dev-usage paths output and dev-usage-integration job (research R20)

.devcontainer/
├── gen-container-secrets-env.sh          # + MCM_USAGE_CLIENT_SECRET in VARS
├── devcontainer.json                     # + MCM_USAGE_INGEST_URL, MCM_USAGE_TOKEN_URL via ${localEnv}
└── sandbox/devcontainer.json             # + the same two

scripts/check-resource-naming.mjs         # admit the dev-usage context (premise change, rule kept)

docs/runbooks/dev-usage.md                # operator steps, doctor, troubleshooting
openwiki/runbooks/dev-usage.md            # concept page citing the runbook
```

**Structure Decision**: the tooling goes in `scripts/` beside `backlog.mjs` and `ci-status.mjs`, with
pure modules under `scripts/lib/cc-usage/` so parsing and rules are unit-testable without IO. The store
is a dedicated stack directory under `infrastructure-as-code/docker/`, deployed by Komodo like every
other prod stack.

## Delivery order

Follows the spec's priorities. Each step is usable on its own, and data accumulates from step 2.

1. **Spike** (no repo change): confirm the open items in research R6, R7, R12, R14 and R18 in the live container; record the results in research.md.
2. **P1 capture**: parser, privacy guard, local state, shipping, hooks, store stack, env plumbing, backup, runbook, oracle check. Exit: SC-001 to SC-005, SC-009.
3. **P2 in-session**: skill and interactive commands. Exit: SC-006.
4. **P3 attribution**: labelling, feature attribution and identity, feature outcomes, weights, views (`v_feature_totals` and the conservation invariant), `feature`/`features` commands, Grafana dashboard. Exit: SC-007, SC-010, SC-011.
5. **P4 findings**: rules, accept/reject, experiment before/after, opt-in statusline. Rules activate after two weeks of data; the spec closes when SC-008 is met.

## Operator steps outside the repository

Documented in `docs/runbooks/dev-usage.md`; none blocks merging:

- Create the client `dev-usage-capture` in the production realm in the Keycloak console (service account on, token lifespan 3600 s, hardcoded claim `role = usage_writer`, audience `dev-usage`), because production's realm is configured by hand; copy its generated secret.
- Create the Komodo Variables `DEV_USAGE_PG_PASSWORD` and `DEV_USAGE_READER_PASSWORD`.
- Add `MCM_USAGE_INGEST_URL`, `MCM_USAGE_TOKEN_URL` and `MCM_USAGE_CLIENT_SECRET` to `~/.mcm-sandbox-env` on the sandbox host and recreate the container.
- Allow the endpoint in the sandbox network policy if the spike shows the policy is per port.
- Open 19040 to the tailnet in the host firewall, as for 19002, 19030 and 19099.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| `prod-observability` compose gains a provisioning mount for a datasource in another stack | Grafana already runs there, and FR-027 puts the dashboard on the existing instance | A second Grafana in `prod-dev-usage` duplicates a component and a published port for one dashboard |
