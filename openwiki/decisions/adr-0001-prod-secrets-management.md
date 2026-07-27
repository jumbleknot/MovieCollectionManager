---
type: Decision
title: "ADR-0001: Production secrets-management standard"
description: The ratified decision record selecting Komodo Variables (not HashiCorp Vault) as the sanctioned production secrets mechanism for all core stacks, with Vault kept dormant and agent-layer-scoped only.
resource: docs/decisions/ADR-0001-prod-secrets-management.md
tags: [adr, secrets, komodo, vault, decision-record, security]
timestamp: 2026-07-04T21:46:33-04:00
---

# ADR-0001: Production secrets-management standard

Accepted decision record (feature 026, Workstream B / US2) ratifying **Komodo Variables** as the one
sanctioned production secrets mechanism for every core stack, rather than adopting HashiCorp Vault as
the backbone. It is a "ratify what already runs" decision, not a greenfield choice: all seven
production stacks already ran on Komodo Variables before this ADR, while Vault was deployed but never
operationalized. Masked Komodo Variables (`[[NAME]]`) are interpolated into each stack's gitignored
`.env.prod` at deploy time behind fail-fast `${VAR:?}` compose references. Vault stays deployed
**dormant** and is reconciled as a narrow, optional, fail-open reader inside the Agent Gateway only —
never a second source of truth for a core stack.

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
  hosts/operators) — do not treat their absence as a gap to silently fix.

This is the decision behind the day-to-day rules on the
[Secrets management posture](/openwiki/invariants/secrets-management.md) page and governs credentials
consumed by the [Agent Gateway](/openwiki/projects/agent-gateway.md)'s optional Vault reader and by
[mc-service](/openwiki/projects/mc-service.md)'s and the [BFF](/openwiki/projects/bff.md)'s datastore
credentials. Full rationale table, secret-category coverage map, and revisit trigger:
`docs/decisions/ADR-0001-prod-secrets-management.md`.
