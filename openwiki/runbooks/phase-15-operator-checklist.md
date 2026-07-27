---
type: Runbook
title: Phase 15 operator checklist (bring the full app live)
description: The manual, operator-only steps that brought the full production app live end-to-end — new mc-service and agent-gateway stacks, the CD deploy=true validation leg, and the ResourceSync config-as-code consolidation that followed.
resource: docs/runbooks/Phase-15-Operator-Checklist.md
tags: [production, komodo, deployment, operator, runbook]
timestamp: 2026-07-27T01:48:47+00:00
---

# Phase 15 operator checklist (bring the full app live)

A one-time operator checklist (Komodo / Keycloak-admin / prod-shell actions that an agent cannot drive)
that took production from BFF-only to the full app — mc-service and the agent gateway deployed as new
Komodo stacks, the agent chain's token-exchange proven end-to-end, the CD `deploy=true` webhook leg
validated with a rollback drill, and the eventual consolidation from manually created stacks into a
single config-as-code Komodo ResourceSync. It was relocated here from `docs/proposals/homelab-setup/`
because it is a live operator record, not pre-specification ideation — see the
[proposal → spec → plan → tasks → implementation lifecycle](/openwiki/process/spec-driven-development.md).

## Gotchas

- **A Keycloak client secret is regenerated on every realm import unless pinned in the realm JSON.**
  The Komodo Variable feeding a confidential client's secret must be copied from the post-import
  Keycloak console, not assumed to match whatever value was set before import — a mismatch fails the
  token exchange with an auth error that looks like a missing-configuration problem, not a wrong-secret
  problem, which is why it recurred at two separate points in this chain (the BFF's subject-token
  exchange and the gateway's own re-exchange) rather than being caught once. See the
  [auth chain](/openwiki/invariants/auth-chain.md) for where each of these exchanges sits.
- **A single manually-attached webhook only redeploys the stack it's attached to.** Because one CD run
  promotes new image digests to all built-image stacks at once, a webhook scoped to only one stack
  leaves the others running stale images with silent drift between the promoted digest and the running
  container — the fix that closes this gap is consolidating onto one ResourceSync webhook that
  redeploys every affected stack in dependency order, not adding more per-stack webhooks.
- **Renaming a live stack in place must preserve its external volumes and networks.** The stack rename
  performed here removed only the old containers, never the `external: true` volumes/networks backing
  them, specifically so already-stored per-user data survived the rename — deleting those resources
  instead of the containers would have been a data-loss mistake.
- **A validated web login bug does not imply the mobile login is fine, or vice versa** — this checklist
  hit one login defect that only manifested on web (a build-time environment variable that never made
  it into the browser bundle) alongside a second, independent defect in the realm's redirect-URI
  configuration; treat a working mobile flow as no evidence about web, and fix both root causes
  separately.
- **A short-lived elevated-privilege token used for one-time validation must be revoked immediately
  after use** — this checklist explicitly calls out revoking such a token as its own checklist item, not
  an implied cleanup step.

Full step-by-step Komodo actions, exact stack configuration values, the two independent login-bug root
causes, and the final deploy-order/secrets-map reference: `docs/runbooks/Phase-15-Operator-Checklist.md`.
