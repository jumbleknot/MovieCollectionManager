---
type: Decision
title: "ADR-0001: Production secrets-management standard"
description: The ratified decision record selecting Komodo Variables (not HashiCorp Vault) as the sanctioned production secrets mechanism for all core stacks, with Vault kept dormant and agent-layer-scoped only.
resource: docs/decisions/ADR-0001-prod-secrets-management.md
tags: [adr, secrets, komodo, vault, decision-record, security]
sources:
  - id: openwiki-source-bff475d8fa855e3592cfedc2
    resource: repo://.specify/memory/constitution.md
  - id: openwiki-source-157ea154f0d418e464705985
    resource: repo://agents/movie-assistant/src/secrets.py
  - id: openwiki-source-3886664bef2237616f46c07e
    resource: repo://agents/movie-assistant/src/tools/token_exchange.py
  - id: openwiki-source-c1146bc275906084150591a5
    resource: repo://docs/decisions/ADR-0001-prod-secrets-management.md
  - id: openwiki-source-abae5c338f9f983f89ea77ad
    resource: repo://docs/runbooks/prod-reboot-resilience.md
  - id: openwiki-source-3b86829117dd0577834407fc
    resource: repo://infrastructure-as-code/docker/vault/compose.prod.yaml
  - id: openwiki-source-8ada931f45dbc32482cecf9f
    resource: repo://infrastructure-as-code/docker/vault/config/vault.hcl
  - id: openwiki-source-839571d2c51f49a930537d1b
    resource: repo://infrastructure-as-code/komodo/stacks.toml
  - id: openwiki-source-cc2828785988d51226a4241e
    resource: repo://renovate.json
  - id: openwiki-source-a6996cae4bd83db81e823602
    resource: repo://scripts/__tests__/komodo-stack-env.guard.test.mjs
  - id: openwiki-source-6a31387312db2b158048d4d9
    resource: repo://scripts/__tests__/renovate-workflow.guard.test.mjs
  - id: openwiki-source-4708763005c35901b04f5740
    resource: repo://security/infra-images/allowlist.yaml
  - id: openwiki-source-2c24e272c750d36f7963e28d
    resource: repo://specs/026-prod-data-auth-vault/spec.md
generated: { by: "openwiki/0.7.1", at: "2026-10-13T10:46:04.907Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-10-25T13:33:13.758Z
---

# ADR-0001: Production secrets-management standard

Accepted decision record (feature 026, Workstream B / US2, dated 2026-07-04) ratifying **Komodo
Variables** as the one sanctioned production secrets mechanism for every core stack, rather than
adopting HashiCorp Vault as the backbone. It is a "ratify what already runs" decision, not a
greenfield choice: all seven production stacks already ran on Komodo Variables before this ADR, while
Vault was deployed but never operationalized. There is exactly one sanctioned mechanism, plus one
narrowly-scoped, optional, fail-open reader in the agent layer — never a second source of truth for a
core stack.

## The decision, distilled

- **The mechanism.** Masked Komodo Variables (`[[NAME]]`) are interpolated into each stack's
  gitignored `.env.prod` at deploy time and consumed behind fail-fast `${VAR:?}` compose references.
  The committed TOML carries only the token; the value lives in Komodo's masked store and in the
  generated `.env.prod`.
- **The scope.** Every production secret category the ADR enumerates is mapped to that one mechanism,
  including the feature-026 datastore credentials. The per-category coverage table is in the ADR.
- **Vault's place.** Deployed **dormant** and reconciled as a narrow, optional, fail-open reader
  inside the [Agent Gateway](../projects/agent-gateway.md) only — never a core-stack backbone.
- **The nature of the decision.** It is a *ratification of the compliant status quo*, not an
  enhancement: it satisfies the "environment variables" leg of the constitution's Secrets Management
  principle ("use environment variables **or** a dedicated secret management tool"), with secrets
  never in source, config files, or version control. Adopting Vault would be the enhancement.
- **Rotation.** Manual by design (see the gotchas); the datastore-credential steps are the
  [prod data-tier auth runbook](../runbooks/prod-data-tier-auth.md)'s job, not this page's.

## Where the decision lives in the repo

The seven core prod stacks are `[[stack]]` blocks in
[`infrastructure-as-code/komodo/stacks.toml`](../../infrastructure-as-code/komodo/stacks.toml):
`prod-auth`, `prod-mc-service`, `prod-mcm-bff`, `prod-movie-assistant`, `prod-audit`,
`prod-observability` and `prod-vault`. All seven declare `env_file_path = ".env.prod"`; six of them
also carry an `environment = """…"""` block in which every secret-bearing value is a masked
`[[Variable]]` token, so the committed file holds no secret and the deploy-time interpolation *is* the
mechanism. `prod-vault` is the one stack with no `environment` block at all — it holds no secret to
interpolate.

"Tokens only" is a rule about **secret-bearing values**, not about every line. Two blocks carry
non-secret literals deliberately: `prod-auth` holds
`PROD_REALM_FILE=/home/prod/keycloak/prod-realm.rendered.json` and composes its admin URL around a
token (`KC_HOSTNAME_ADMIN=http://[[TAILNET_HOST]]:19099`), and `prod-mcm-bff` holds
`BACKUP_CONSENT_CLIENT_ID=mcm-backup-consent`, the client id that selects the dedicated
scheduled-backup consent client instead of the login client. The token names themselves are ordinary
Komodo Variable keys and are not uniformly cased — the `prod-mcm-bff` block uses lowercase names such
as `[[mcm_keycloak_client_secret]]` and `[[mcm_agent_config_enc_key]]` alongside uppercase ones. Other
non-secret operational values — bare image digests in the committed `.env.deploy`, and topology
values, which are `[[Variable]]` tokens rather than inline literals — travel by their own channels and
sit outside the ADR's coverage map.

Seeding is a precondition of the sync, not part of it. A masked `[[Variable]]` that does not exist in
Komodo yet interpolates **empty** into `.env.prod`, so the stack's fail-fast `${VAR:?}` reference
aborts the deploy — the intended failure, and the reason the TOML names the Variables that must exist
before the first sync referencing them: `LANGFUSE_RUSTFS_SECRET_KEY` for `prod-observability`, and
`BACKUP_CREDENTIAL_ENC_KEY`, `BACKUP_TICK_SECRET` and `mcm_backup_consent_client_secret` for
`prod-mcm-bff` (the last of those created in the Keycloak admin console, because `kcadm`'s password
login cannot satisfy the admins' 2FA). The same block records that the destination allow-list is an
exact host match with no port.

The coupling that makes this safe to change: Komodo writes a stack's `environment` block into that
stack's `env_file_path`, so a variable absent from the block is absent at `docker compose config`
time and the compose's `${VAR:?}` reference aborts the deploy. Adding a required `${VAR:?}` to a prod
compose is therefore a change to that stack's declared inputs in `stacks.toml` — a break that is
invisible in CI (the compose files are valid, the image exists, and the dev stack works because its
own generated `stacks/<stack>.env` supplies the value) and only surfaces on a real Komodo deploy.

Two live instances of that coupling, in opposite directions, are recorded in the guard test's own
header. Feature 069 repointed the observability object store at the repository's own build, which made
`prod-observability` the *fourth* consumer of `REGISTRY_HOST` — but `stacks.toml` declared that
variable for the other three stacks only, and the deploy died on
`required variable REGISTRY_HOST is missing a value`. Feature 080 then replaced that image with
upstream RustFS, which **removed** `REGISTRY_HOST` from the block and **added**
`LANGFUSE_RUSTFS_SECRET_KEY` — the same coupling in the other direction, and the guard went red on the
new variable until the block declared it.

`scripts/__tests__/komodo-stack-env.guard.test.mjs` makes that coupling mechanical instead of
remembered. It parses every `[[stack]]` block, collects the variables each stack declares — from its
`environment` block *and* from any committed `additional_env_files`, so a digest supplied by
`.env.deploy` counts as supplied — collects the `${VAR:?}` names each of the stack's `file_paths`
compose files requires, and asserts the gap list is empty. It is deliberately scoped to the fail-fast
form only (an optional `${VAR}` or `${VAR:-default}` is by definition allowed to be absent, and gating
those would flag every tunable in the tree), it strips comment lines before scanning, and it skips a
`file_paths` entry that does not exist on disk. A second test proves the guard is not vacuously green:
it deletes the live variable from a copy of the TOML and asserts the parser no longer reports it as
supplied while the compose still requires it. The full gate set is on the
[Secrets management posture](../invariants/secrets-management.md) page.

`prod-vault` is the exception that proves the rule: it declares no secret at all. It runs a real,
non-dev Vault — digest-pinned `hashicorp/vault:2.2@sha256:e0acd3c6…` — on raft storage,
**uninitialized and sealed**, with no root token anywhere in env, and a healthcheck override that
reports the dormant state as healthy so Komodo keeps it up. Do not run the init/unseal sequence as a
side effect of an unrelated change. The dormant posture was re-verified against that pin — uninitialized
and sealed, one vault process, healthcheck passing, and init → unseal → KV write → restart → re-unseal
all holding on raft — and the image is not free to drift: a vault **major** now needs an explicit
dependency-dashboard approval, with the infra-image scan gate covering patch and minor. The `<1.19`
ceiling that this replaced was a security hold, lifted only once 2.2.0 scanned clean.

## The one optional reader

```mermaid
flowchart TD
  Req["A core stack needs a credential at deploy"] --> Var["Masked Variable token in stacks.toml"]
  Var --> Env["Komodo writes the interpolated value into the gitignored .env.prod"]
  Env --> Compose["Compose resolves the fail-fast reference and aborts if it is unset"]
  Compose --> Consumer["The service reads the credential from its environment"]
  Agent["Agent gateway resolve_secret"] --> Gate{"VAULT_ADDR and VAULT_TOKEN both set"}
  Gate -->|"no"| EnvRead["Read the Komodo-injected environment"]
  Gate -->|"yes"| KV["Read the KV v2 secret at secret/movie-assistant"]
  KV -->|"key present"| Use["Use the Vault value"]
  KV -->|"error or key absent"| EnvRead
```

The single sanctioned path, plus the dormant Vault reader's fail-open fallback.

`resolve_secret(name, env)` in `agents/movie-assistant/src/secrets.py` reads the KV v2 secret at
`secret/movie-assistant` **iff** `VAULT_ADDR` and `VAULT_TOKEN` are both set, and otherwise falls
straight through to the Komodo-injected environment. It is env-gated, per-run, never logs a value, and
never raises on a Vault error. Its only live caller is the gateway's RFC 8693 token re-exchange, which
needs `AGENT_GATEWAY_CLIENT_SECRET` and fails closed — it raises rather than defaulting — when neither
source supplies it. In production today those two env vars are unset, so the reader is inert.

## Gotchas

- **Vault was evaluated and explicitly rejected, not just deferred by inertia.** The rationale table in
  the ADR weighs rotation, dynamic DB credentials, audit granularity, and availability coupling — on a
  single-host, single-operator homelab, Vault's real advantages aren't pressing, while its real cost is
  concrete: every host reboot brings Vault up **sealed**, silently blocking every deploy until a manual
  unseal. Don't reintroduce Vault as a core-stack dependency without revisiting this reasoning.
- **A half-adopted Vault (some secrets in Vault, some in Komodo) is explicitly called out as worse than
  either pure option.** If a change moves one secret into Vault while the rest stay in Komodo, that is
  the exact dual-mechanism ambiguity this ADR forbids — not a reasonable incremental step.
- **The agent-layer Vault reader must always fail open to the Komodo-injected environment.** It reads
  at most one or two secrets *iff* the Vault address and token env vars are set, and otherwise silently
  falls back — it must never crash on a Vault error or become an independent source of truth. In
  production today those env vars are unset, so the reader is inert.
- **Per-user bring-your-own credentials are explicitly out of scope for this ADR.** User-supplied
  provider credentials are encrypted at rest per-user and never centralized into Komodo or Vault — a
  request with no per-user credential fails closed, it does not fall back to a shared secret.
- **Rotation is manual by design under this decision**, not an oversight: rotating a secret means
  editing the Komodo Variable and redeploying the affected stack. Automated rotation, lease/TTL, and
  fine-grained secret-access audit are named, explicit non-goals until the ADR's §7 revisit trigger
  fires (dynamic short-lived DB credentials wanted, mandated rotation/audit, or a move to multiple
  hosts/operators) — do not treat their absence as a gap to silently fix. Blast radius is per
  credential and the declared-input list records the worst case: rotating `mcm_backup_credential_enc_key`
  orphans every stored backup destination secret and offline token, which is why that line is
  accompanied by an explicit "never rotate casually" warning.
- **The `komodo-stack-env` guard checks one direction only.** It proves every required variable is
  *supplied*; it says nothing about a declared input no compose reads any more, or a Komodo Variable no
  longer referenced by any `environment` block. Both happen, and neither is self-cleaning: the
  `environment` block is a hand-maintained declared-input list, so `KC_ADMIN_BIND_IP` and `TS_ADMIN_IP`
  each outlived the compose bind that read them, and feature 080 deliberately leaves `REGISTRY_HOST`
  and `LANGFUSE_MINIO_ROOT_PASSWORD` seeded in Komodo until the object-store rollback window closes,
  because reverting that change restores the lines that reference them. Removing a consumer is not the
  same edit as removing the input — see
  [Infrastructure stacks](../projects/infrastructure-stacks.md) for the retired-variable record.

Because B-opt-1 was selected, feature 026's US3 migration plan was never executed and no migration
artifact exists; it would become the first deliverable of a follow-up Vault-adoption feature if the
§7 trigger fires. Workstream A meanwhile shipped static SCRAM datastore credentials rather than
waiting on Vault-issued ones.

This is the decision behind the day-to-day rules on the
[Secrets management posture](../invariants/secrets-management.md) page and governs credentials
consumed by the [Agent Gateway](../projects/agent-gateway.md)'s optional Vault reader and by
[mc-service](../projects/mc-service.md)'s and the [BFF](../projects/bff.md)'s datastore
credentials. Full rationale table, secret-category coverage map and revisit trigger:
[`docs/decisions/ADR-0001-prod-secrets-management.md`](../../docs/decisions/ADR-0001-prod-secrets-management.md).
