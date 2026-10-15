---
type: Convention
title: Dev stack env files and local secret generation
description: The two-file-per-stack env contract under infrastructure-as-code/docker/stacks — the four committed <stack>.env.example templates that are the single source for each stack's keys and generation kinds, the gitignored <stack>.env files minted from them by scripts/gen-dev-secrets.mjs, how those files become Compose's interpolation source, the fail-fast ${VAR:?…} contract, and the traps (back-fill rather than a plain skip, password-on-first-init credentials, the deliberately blank REGISTRY_HOST).
resource: infrastructure-as-code/docker/stacks/README.md
tags: [infrastructure, docker-compose, secrets, env-vars, dev-environment, gates]
sources:
  - id: openwiki-source-fd77a504cc309a02ead6fecf
    resource: repo://.forgejo/workflows/guardrails.yml
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-f84ce669ebf8d13e89ba2f75
    resource: repo://docs/runbooks/local-dev.md
  - id: openwiki-source-7a0ce0b0b1a10dd515633969
    resource: repo://infrastructure-as-code/docker/agent-gateway/compose.yaml
  - id: openwiki-source-34479801b303c2005c7d1de1
    resource: repo://infrastructure-as-code/docker/agents/compose.prod.yaml
  - id: openwiki-source-3e3aa9cad6614ff0bc5e5058
    resource: repo://infrastructure-as-code/docker/backups/compose.yaml
  - id: openwiki-source-03de7146fd7e33f2e3019d9d
    resource: repo://infrastructure-as-code/docker/bff/compose.prod.yaml
  - id: openwiki-source-73ccac5c4c3b2e02cb1b3ec1
    resource: repo://infrastructure-as-code/docker/keycloak/compose.yaml
  - id: openwiki-source-d5b1faab58eeb909bb999298
    resource: repo://infrastructure-as-code/docker/mc-service/compose.prod.yaml
  - id: openwiki-source-852cc196002c1a675baddf5c
    resource: repo://infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh
  - id: openwiki-source-0ff61f596da1302e58282fa2
    resource: repo://infrastructure-as-code/docker/observability/compose.yaml
  - id: openwiki-source-18dcf2373667222e1bc520c1
    resource: repo://infrastructure-as-code/docker/stacks/audit.compose.yaml
  - id: openwiki-source-79878dc2da65b6b5c71034f7
    resource: repo://infrastructure-as-code/docker/stacks/auth.compose.yaml
  - id: openwiki-source-f71a8c09fa1dfc3547dbcf23
    resource: repo://infrastructure-as-code/docker/stacks/auth.env.example
  - id: openwiki-source-164936b930a31e48cf0a65fc
    resource: repo://infrastructure-as-code/docker/stacks/mcm.compose.yaml
  - id: openwiki-source-90e20f6cb63d8bd67d0fd623
    resource: repo://infrastructure-as-code/docker/stacks/mcm.env.example
  - id: openwiki-source-803bcd8d160132605ee08429
    resource: repo://infrastructure-as-code/docker/stacks/observability.compose.yaml
  - id: openwiki-source-3d0ce5a1df7b9900637ae21d
    resource: repo://infrastructure-as-code/docker/stacks/observability.env.example
  - id: openwiki-source-fdcb17fe6bc4f12ade7e61d0
    resource: repo://infrastructure-as-code/docker/stacks/README.md
  - id: openwiki-source-5731c4a4c76f88db8cc6fb40
    resource: repo://infrastructure-as-code/project.json
  - id: openwiki-source-b04e37691ebfb88e99a080d8
    resource: repo://scripts/__tests__/doc-env-example-citations.guard.test.mjs
  - id: openwiki-source-71f7bcd684b90eabd6ed3b4a
    resource: repo://scripts/__tests__/gen-dev-secrets.guard.test.mjs
  - id: openwiki-source-85a6abb4f828129c0cce9653
    resource: repo://scripts/check-no-inline-secrets.mjs
  - id: openwiki-source-6f10e821d1ec074deb438a3e
    resource: repo://scripts/check-topology-scrub.mjs
  - id: openwiki-source-d046d2ddea9d1d430ec2c0d2
    resource: repo://scripts/gen-dev-env.mjs
  - id: openwiki-source-1dabdb308579a8f9d6d49612
    resource: repo://scripts/gen-dev-secrets.mjs
generated: { by: "openwiki/0.7.1", at: "2026-10-15T01:57:21.062Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-10-15T01:57:21.062Z
---

# Dev stack env files and local secret generation

Feature 021 (externalize-compose-secrets) removed every clear-text credential from the tracked Docker
Compose files: most secrets are now fail-fast `${VAR:?…}` interpolation references, and the real
per-machine values live in gitignored per-stack `.env` files generated from committed templates. This
page covers that env-file and dev-credential layer only — for the Compose topology, the four stacks'
profiles and includes, and the production Komodo stacks, see
[Infrastructure-as-code stacks](./infrastructure-stacks.md), which owns the other half of the same
directory. The authoritative reference for the file contract itself is
[`infrastructure-as-code/docker/stacks/README.md`](../../infrastructure-as-code/docker/stacks/README.md);
it deliberately lists **no keys**, because each stack's key set and the generation kind of every
minted key are carried by that stack's `.env.example` template, which is the single source for both.

## The two-file contract

| File | Tracked? | Purpose |
|---|---|---|
| `<stack>.env.example` | committed | Placeholder template. `NAME=<generate:KIND>` for a minted value; `NAME=literal` for a deterministic fixture. |
| `<stack>.env` | gitignored | Generated real values, read by Compose. **Never commit.** |

`<stack>` ∈ `auth`, `mcm`, `audit`, `observability` — the four named stacks, matching the four
`.env.example` templates in `infrastructure-as-code/docker/stacks/`. Each template carries the complete
key set for its stack, in the order it is minted, with a comment above each key naming what consumes it;
each one says in its own header that it is committed and that no real value may go in it. The
load-bearing distinction inside a template is between a `<generate:KIND>` placeholder (freshly minted
every generation) and a literal (copied verbatim, a fixture the tests and the agent layer authenticate
against).

The generated file reaches Compose through **two** mechanisms, and both matter:

- the stack aggregator's `include:` **long syntax with an `env_file:` pin**, which names that stack's
  `.env` as the interpolation source for the specific included component files that need it — `auth`
  pins `keycloak` + `vault`, `mcm` pins `agent-db` + `agent-gateway`, `audit` pins `opensearch`,
  `observability` pins `observability`;
- the **Nx target's `--env-file`** (`up-auth`, `up-mcm`, `up-audit`, `up-observability`, `up-all` and
  their `down-*` counterparts in `infrastructure-as-code/project.json`), which supplies the variables
  for the whole `docker compose` invocation.

The `include` pin and the `--env-file` are not redundant: the pin makes a component file's own
`${VAR:?…}` refs resolve when that file is included, while the Nx argument covers the aggregator
invocation as a whole. A template's key set is also not simply "what local dev uses" — `mcm.env` mixes
`AGENT_DB_PASSWORD`, which the included `agent-db`/`agent-gateway` files interpolate in plain local dev,
with the `MONGO_*` app/root passwords and keyfile that only the prod compose files and the scratch
environment that mirrors prod consume, because plain local dev runs MongoDB unauthenticated. One file
per stack, several consumers, one minting command.

```mermaid
flowchart TD
  Tmpl["stack .env.example (tracked)"] --> Gen["node scripts/gen-dev-secrets.mjs"]
  Gen --> Env["stacks stack .env (gitignored)"]
  Env --> Inc["aggregator include env_file pin"]
  Env --> Nx["Nx up-* target --env-file"]
  Inc --> Compose["docker compose up or config"]
  Nx --> Compose
  Compose -->|"VAR set"| Up["stack starts"]
  Compose -->|"VAR blank or missing"| Abort["abort naming the variable and its env file"]
  Env --> Proj["node scripts/gen-dev-env.mjs"]
  Proj --> Bff["BFF .env.docker / .env.local / .env.e2e.local"]
```

How a value travels from the committed template into a running container, and where the chain aborts.

## Commands

```bash
node scripts/gen-dev-secrets.mjs                        # mint every missing <stack>.env (idempotent)
node scripts/gen-dev-secrets.mjs --force                # rotate ALL (overwrite)
node scripts/gen-dev-secrets.mjs --force --stack=auth   # rotate one stack
node scripts/gen-dev-env.mjs                            # project auth.env's realm secrets into the BFF env files
```

`gen-dev-secrets.mjs` exits `0` on success, `1` on a missing/malformed template or unwritable output,
`2` on bad arguments (an unknown `--stack` value or an unknown flag). A second
`node scripts/gen-dev-env.mjs` run is a separate step in the same layer:
it projects the realm client secrets out of `stacks/auth.env` into the BFF's gitignored env files
(`frontend/mcm-app/.env.docker`, `.env.local`, `.env.e2e.local`, the web-api-mcp TMDB file, and
`backend/mc-service/.env.local`) so the imported dev realm's client secrets and the BFF's client
secrets agree **by construction** rather than by hand. It verifies the projected credentials against
the *running* realm before writing anything (exit `2` = refusing to write, files left untouched). See
[Keycloak](./keycloak.md) for the realm side and
[Local dev](../../docs/runbooks/local-dev.md) — "A projected credential can be STALE, not merely
absent (item #395)" — for the detect → resolve procedure.

Reach for the generator once per machine before any `up-*`, and again after pulling a change that
adds a variable to a template. Reach for `--force` only when you actually mean to rotate.

## Generation kinds

The kinds exist so the alphabet matches where the value is consumed — a value interpolated into a URL
or a shell command cannot carry characters that break either:

- `b62-32` / `b62-48` — URL- and shell-safe base62; used where the value is embedded in a connection
  URL or a bearer token shape.
- `hex-64` — 32 random bytes rendered as hex; Keycloak client secrets and `LANGFUSE_ENCRYPTION_KEY`.
- `complex-16` — upper + lower + digit + special, drawn from a URL/shell-safe special set
  (`-_.!=+`), so the value survives a `-u user:pass` curl argument, a YAML double-quoted scalar, and
  `sh`; used for passwords that are *not* URL-embedded.
- `unleash-admin` / `unleash-client` — the two Unleash token shapes (a `*:*.` / `default:development.`
  prefix plus a base62 body).
- `mongo-keyfile` — the MongoDB replica-set keyfile **content** as a single-line base64 value,
  materialized to a `0400` in-container file at start-up by `mc-service/mongo-entrypoint.sh` (env-only,
  no host file-secret).

Randomness comes from `node:crypto` with rejection sampling rather than a modulo, so the characters are
unbiased. An unknown kind is a hard error naming the key, not a silently empty value. Which key uses
which kind is recorded in the template beside the key itself, not in the README — see
`infrastructure-as-code/docker/stacks/<stack>.env.example`.

## Fail-fast: a blank credential aborts, it does not degrade

A credential in a tracked compose file is an interpolation reference, never a literal: the
`check-no-inline-secrets` gate below accepts only a pure `${VAR}` or `${VAR:?message}`, so an inline
literal and a `${VAR:-default}` both fail. The dev stacks and the component files they include use the
fail-fast `${VAR:?…}` form, so if the value is unset or blank, `docker compose up` / `config` aborts
naming the missing variable and the file that should hold it, rather than starting a half-configured
stack:

```
required variable KC_BOOTSTRAP_ADMIN_PASSWORD is missing a value: set in stacks/auth.env (run: node scripts/gen-dev-secrets.mjs)
```

The message is deliberately actionable: it names the variable, the per-stack env file, and the command
that mints it. This is also why the blank `REGISTRY_HOST` in two templates is a feature rather than an
omission (see the gotchas).

Two shapes are deliberately outside that rule. The optional Control Tower consumer values — the
OpenSearch / LangFuse / Unleash settings the BFF and the agent gateway read in the prod compose files —
are plain `${VAR}` rather than `${VAR:?…}`, so a missing observability value makes that integration a
no-op instead of aborting the app. And a handful of non-credential names that merely look secret-shaped
are allowlisted by the gate (see below). Separately, a service that needs a *file* of settings rather
than interpolation reads it through its own `env_file:` — the BFF reads
`frontend/mcm-app/.env.docker`, web-api-mcp reads `mcp-servers/web-api-mcp/.env.local` — which is a
different mechanism from the per-stack `.env` this page is about.

## Gotchas

- **`node scripts/gen-dev-secrets.mjs` is idempotent but it is NOT a plain skip.** An existing
  `<stack>.env` is *completed*: keys the template has gained since the file was written are seeded, and
  a `<generate:KIND>` key that is present but **empty** (`KEY=`) is minted in place — an empty secret is
  a missing secret. Every existing value is left exactly as it is, including one a developer edited by
  hand, and the existing lines are kept byte-for-byte. The reason it is not a plain skip is that the
  only alternative for delivering one new variable would be `--force`, which rotates every *other*
  value and takes the running stacks down to add one. The failure mode this replaces is the silent-skip
  defect (item #552): the run reported "up to date", the suites that needed the absent keys skipped to
  green, and nothing named why. The run prints the seeded/filled key **names** and then says that
  containers started before it do not hold the new values.
- **A blank *fixture* key is deliberately not touched.** `REGISTRY_HOST` is left empty in the `mcm` and
  `observability` templates on purpose: `scripts/check-topology-scrub.mjs` forbids a real host in a
  committed file, so it is set per machine. The generator has no value to give it and does not treat it
  as a gap — a file whose only "missing" key is a blank fixture still reports up to date. Left blank,
  the compose image refs fail loudly naming the variable instead of silently resolving to an invalid
  reference. Note the two consumers differ: `observability.env` feeds the `observability` stack's own
  MinIO image refs, whereas `mcm.env`'s value is consumed by the **separate**
  `infrastructure-as-code/docker/backups/compose.yaml`, brought up explicitly — it is deliberately not
  an include of `mcm.compose.yaml`, because Compose interpolates every service in an included file at
  parse time regardless of the selected profiles, so a profile-gated `${REGISTRY_HOST:?}` there once
  broke `up` for the whole stack.
- **The two LangFuse `LANGFUSE_INIT_PROJECT_*` fixture keys are copied verbatim even under `--force`.**
  They are deterministic fixtures, not randomized credentials: the agent gateway and a verify test
  authenticate against those exact values, so randomizing them would break both. The same holds for the
  fixed public halves of the backup-destination fixtures in `mcm.env` (the S3 access key and WebDAV
  username are fixed so the integration suite can name them without reading the file).
- **Password-on-first-init credentials survive a rotation until the volume is recreated.** Postgres,
  OpenSearch and MinIO bake their password into the data volume on first init and ignore later env
  changes. Rotating the `.env` therefore is not enough: the service must be recreated with a fresh
  volume (`docker volume rm <name>` then re-create), or the container keeps the volume's original
  password and auth fails. Redis values, Unleash tokens and app secrets have no such persistence and
  rotate on a plain restart. The trap is sharpest for the Keycloak database password, which is
  deliberately a **single** `auth.env` key that both the Postgres service (`POSTGRES_PASSWORD`) and
  keycloak-service (`KC_DB_PASSWORD`) interpolate: on an existing dev volume the newly minted value is
  simply wrong, and the documented recovery is to set the key back to the volume's original value or
  wipe the volume and let `up-auth` re-import the realm.
- **A container started before a re-run does not hold a newly minted value.** The generator mints into
  the file, not into the running process. The services that consume a newly seeded value must be
  recreated, and then `node scripts/gen-dev-env.mjs` re-run to project the value into the BFF env
  files.
- **The generator prints key NAMES only, never values.** This is enforced, not conventional: the guard
  test asserts that no non-trivial value in the written file appears anywhere in the generator's
  output.

## The boundary that keeps this out of git

`<stack>.env` is gitignored; `<stack>.env.example` is tracked. `.gitignore` ignores `*.env` and
`*.env.*` wholesale and then carves the templates back in with an **explicit, scoped** un-ignore:
`!infrastructure-as-code/docker/stacks/*.env.example`. The scope is the point — a bare `!*.env.example`
would also un-ignore other deliberately-ignored templates such as `frontend/mcm-app/.env.example`
(feature 019). A parallel carve-out tracks `infrastructure-as-code/docker/**/*.env.prod.example`, while
real `.env.prod` values stay ignored.

Two static gates back the boundary up, both run selftest-then-scan in the `naming` job of
`guardrails.yml`:

- `scripts/check-no-inline-secrets.mjs` asserts the structural property that **no tracked compose file
  holds a literal credential**. Every secret-shaped key, password-bearing connection URL, and
  command/healthcheck/entrypoint auth literal must be a pure `${VAR}` / `${VAR:?message}` reference. An
  inline `${VAR:-default}` **fails** too, because a default re-leaks plaintext — that is the whole point
  of the `:?` form. Non-credential keys that merely match the name pattern (`*_FILE`, `*_USER`,
  `*ACCESS_KEY_ID`, `*_CLIENT_ID`, `*_AUDIENCE`) are explicitly allowlisted. It runs locally via
  `node scripts/check-no-inline-secrets.mjs` (or `--selftest`, or the `check-no-inline-secrets` Nx
  target).
- `scripts/check-topology-scrub.mjs` is the tree-wide gate that keeps a real tailnet host out of any
  committed file — which is what makes the blank `REGISTRY_HOST` necessary rather than sloppy. It is
  pattern-based rather than literal, because hard-coding the real host would itself re-leak it. See
  [CI/CD pipeline](./ci-cd-pipeline.md) for the workflow that runs both, and
  [Secrets management](../invariants/secrets-management.md) for the posture they enforce.

## Focused tests

`scripts/__tests__/gen-dev-secrets.guard.test.mjs` pins the back-fill contract (item #552): an existing
`mcm.env` missing the backup-destination keys gets all of them seeded, no existing value is rotated,
the seeded keys are *named* in the output, an empty placeholder key is minted in place without being
duplicated, a blank fixture key is not treated as missing, and no value is ever printed. The tests copy
the generator into a throwaway mini-repo, so they are offline and keyless and never touch a developer's
real `stacks/*.env`. `scripts/__tests__/gen-dev-env.guard.test.mjs` covers the projection side, and
`scripts/__tests__/doc-env-example-citations.guard.test.mjs` fails when live documentation cites a
`.env*.example` that is not actually tracked — a dangling template pointer reads to a fresh clone as a
broken repository. That guard resolves citations with `git ls-files` rather than `existsSync`, precisely
because `.gitignore`'s `*.env.*` rule makes an untracked template look present on the author's machine;
it scans `docs/**` (minus `docs/proposals/**`) and `**/README.md` (minus `specs/` and `openwiki/`), and
carries a small `DELIBERATELY_ABSENT` list for prose *about* a missing template — an entry there is
itself a claim, so the test fails if the cited file starts resolving.

Do not reproduce a value from any `.env` file anywhere — not in a doc, not in a command line, not in a
commit message. Compare key names, never values.

See [Local dev](../../docs/runbooks/local-dev.md) for the bring-up loop these files feed, and
[Dev environment setup](../runbooks/dev-environment-setup.md) for the first-time machine setup.
