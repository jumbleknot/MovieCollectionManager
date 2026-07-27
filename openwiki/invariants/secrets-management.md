---
type: Decision
title: Secrets management posture
description: The no-clear-text-secrets-in-git rule, why Komodo Variables (not Vault) is the sanctioned production secrets mechanism, and how CI gates enforce both.
resource: docs/decisions/ADR-0001-prod-secrets-management.md
tags: [secrets, security, komodo, vault, ci-gates]
timestamp: 2026-07-04T21:46:33-04:00
---

# Secrets management posture

Rule, stated in the constitution and repeated in `CLAUDE.md`: no clear-text secret in git, ever.
Secrets live in environment variables, sourced differently per environment, and every mechanism is
enforced by a CI gate rather than relying on developer discipline alone.

- **Dev**: `node scripts/gen-dev-secrets.mjs` mints gitignored per-stack `.env` files from committed
  `*.env.example` templates (placeholders only). Compose files reference every secret as
  `${VAR:?set in stacks/<stack>.env}` — a fail-fast interpolation, never an inline literal and never
  a `${VAR:-literal}` default (a default *is* a leaked value).
- **Production**: **Komodo Variables** are the one ratified mechanism for all core stacks
  (`ADR-0001-prod-secrets-management.md`). Masked Komodo Variables are interpolated into each
  stack's gitignored `.env.prod` at deploy time behind the same fail-fast `${VAR:?}` pattern.
- **HashiCorp Vault is deployed but deliberately dormant** for core stacks, and kept only as a
  narrow, optional, fail-open reader inside the [Agent Gateway](/openwiki/projects/agent-gateway.md)
  (`agents/movie-assistant/src/secrets.py`): it reads exactly one or two secrets (the gateway's
  Keycloak client secret, and `AGENT_CONFIG_ENC_KEY`) *iff* `VAULT_ADDR`/`VAULT_TOKEN` are set, and
  otherwise falls back to the same Komodo-injected environment. It never crashes on a Vault error and
  never becomes a second source of truth — in production today those vars are unset, so this reader
  is inert and every agent secret resolves from Komodo.
- **Per-user bring-your-own credentials** (a user's own TMDB key, model-provider key, Ollama URL) are
  a separate, orthogonal case: AES-256-GCM-encrypted at rest in the BFF's own Mongo collection,
  never centralized into Komodo or Vault, and never falling back to a shared credential if the
  user's own is absent — the request fails closed instead.

## Gotchas

- **Vault was rejected as the core-stack backbone, not just deferred by inertia.** ADR-0001's
  reasoning: on a single-host, single-operator homelab, Vault's real advantages (dynamic short-lived
  DB credentials, fine-grained access audit, central rotation) aren't pressing, while its real cost
  is concrete — every host reboot brings Vault up *sealed*, silently blocking every deploy until a
  manual unseal. A half-adopted Vault (some secrets in Vault, some in Komodo) is explicitly called
  out as worse than either pure option. If you're tempted to move a core-stack secret into Vault,
  that's the trigger to revisit the ADR, not to quietly diverge from it.
- **The rule is not compose-file-only.** Shell scripts, integration tests, and docs must also read
  secrets from env and fail/skip cleanly when unset — no literal, no `?? 'literal'` fallback. This is
  exactly how a past literal slipped past a compose-only gate for months.
- **One password, two consumers.** `KC_DB_PASSWORD` is a single variable interpolated by *both* the
  Postgres service and Keycloak itself — there is no separate Postgres-side password to keep in
  sync.
- **CI enforces this with dedicated gates**, not just review: `scripts/check-no-inline-secrets.mjs`
  (fails on any inline literal in a compose file), `scripts/secret-scan.mjs` (scans the whole tracked
  tree, including generated docs, for credential-shaped strings), `scripts/check-topology-scrub.mjs`
  / `scripts/check-komodo-sync.mjs` (block the real domain/tailnet host/IP from ever landing in git),
  and `scripts/check-no-argv-secrets.mjs` (blocks passing a credential on argv to the Maestro
  runner). A generated wiki page is scanned by these same gates — never reproduce a real hostname,
  host+port pair, or credential-shaped string on a wiki page; refer to them abstractly (see
  `openwiki/INSTRUCTIONS.md` §3).
- **Rotation is manual, by design, under this ADR.** Rotating a secret means editing the Komodo
  Variable and redeploying the affected stack — there is no automated rotation until the ADR's §7
  revisit trigger fires (dynamic DB credentials, mandated audit, or a move to multiple hosts/
  operators).

This governs the credentials that the [auth chain](/openwiki/invariants/auth-chain.md) depends on
(Keycloak client secrets, BFF cookie/encryption keys) as well as datastore credentials for
[mc-service](/openwiki/projects/mc-service.md) and the [BFF](/openwiki/projects/bff.md). Full
category-by-category coverage map, rationale table, and the revisit trigger:
`docs/decisions/ADR-0001-prod-secrets-management.md`; day-to-day rules and CI gate list live in
`CLAUDE.md`'s Configuration section.
