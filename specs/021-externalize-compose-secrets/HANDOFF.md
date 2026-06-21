# Feature 021 — Implementation Handoff

**Branch**: `021-externalize-compose-secrets` · **Status**: US1 + US2 implemented & validated; US3 (history scrub) deferred to a coordinated post-merge step.

## What shipped

Every clear-text credential in the tracked Docker Compose tree is now a fail-fast `${VAR:?msg}`
interpolation reference. Real per-machine values are minted by `scripts/gen-dev-secrets.mjs` from
committed `infrastructure-as-code/docker/stacks/<stack>.env.example` templates into gitignored
`<stack>.env` files. A static CI gate (`scripts/check-no-inline-secrets.mjs`, wired into
`naming-gate.yml`) blocks any re-inlined literal.

- 6 component compose files edited (keycloak, vault, agent-db, agent-gateway, opensearch, observability).
- 17 canonical vars = 15 randomized + 2 deterministic LangFuse fixtures (kept verbatim).
- New: gate, generator, 4 `*.env.example`, `.gitignore` carve-out, `stacks/README.md`, Nx
  `check-no-inline-secrets` target, `--env-file` on every up/down target, runbook section.

## R1 outcome actually used (the open mechanism question)

**Per-`include` long-syntax `env_file:` is the load-bearing interpolation source.** Each
`stacks/<stack>.compose.yaml` `include` entry that pulls a credential-bearing component file pins
`env_file: ./<stack>.env`. The Nx targets *also* pass `--env-file …/<stack>.env` as belt-and-braces.

Verified empirically (pinned Docker Compose 29.4.2): `docker compose -p <stack> -f <stack>.compose.yaml
--env-file <stack>.env [--profile …] config` renders **every** `${VAR}` resolved with **zero**
`variable is not set` warnings, for all four stacks. No observed leakage of an include's `env_file`
vars into unrelated services' container environment in the rendered `config` (the R1 caveat) — the
`env_file` scopes to interpolation, not injection.

## Validated (this session)

- Gate: RED on the pre-edit tree (35 literals), GREEN after edits, `--selftest` passes. CI-wired.
- Generator: correct KIND invariants (b62/hex-64/complex-16/unleash-*), fixtures verbatim,
  idempotent (2nd run byte-identical), `--force` rotates randomized & keeps fixtures.
- Gitignore boundary: `*.env` ignored, `*.env.example` tracked; no `.env` stageable.
- **AC4 fail-fast** confirmed: an empty/unset required var aborts `config`/`up` with, e.g.
  `required variable KC_BOOTSTRAP_ADMIN_PASSWORD is missing a value: set in stacks/auth.env (run: node scripts/gen-dev-secrets.mjs)`.
- **Live container proof** (non-destructive, isolated project): `langfuse-redis` brought up on the
  generated `observability.env` went **healthy** — its `command --requirepass ${VAR}` and healthcheck
  `redis-cli -a ${VAR}` interpolate to the same value; correct pw → PONG, wrong pw → rejected.
- C1 cross-gate: feature-018 `secret-scan.mjs` stays GREEN with the templates **tracked** (the
  `<generate:…>` placeholders + `pk-lf/sk-lf` fixtures don't match its Anthropic/TMDB shapes).
- Resource-naming gate (019/020) still GREEN.

## Residual caveats

- **Password-on-first-init confound (postgres / OpenSearch / minio)**: these images bake the password
  into their data volume on first init and ignore later env changes. A pre-existing dev environment
  (volumes already initialized on the old literals) will NOT pick up a rotated value without a fresh
  volume — this is expected image behaviour, not a defect. A clean checkout (fresh volumes) gets the
  generated values directly. Documented in `docs/runbooks/local-dev.md`. This is why full multi-stack
  bring-up on generated values is the *clean-checkout* path; the redis live-proof above is the
  volume-independent equivalent.
- **US3 / T022 — history scrub is DEFERRED**: `specs/021-externalize-compose-secrets/replacements.txt`
  is built and ready, but `git filter-repo` must run on a fresh mirror clone post-merge and force-push;
  do NOT run it on the feature branch. Needs `git-filter-repo` (dev tool; `pipx install git-filter-repo`).
- **CRLF**: the committed `*.env.example` normalize LF→CRLF on Windows checkout; the generator reads
  with `/\r?\n/`, so both line endings parse fine.

## Merge note

US1 + US2 must ship in the **same merge** (US1's `${VAR:?}` makes stacks unstartable until US2's
generator + env wiring exist). Recommended order already implemented: Setup → Foundational → US1 → US2
→ Polish. US3 follows as the separate coordinated scrub.
