---
type: Convention
title: Published-port reservation convention
description: The reserved 19000-19099 host-port range for production admin/UI ports, and the shared-host collision it exists to prevent between the homelab's prod stacks and its CI runner.
resource: docs/runbooks/prod-reboot-resilience.md
tags: [ports, ci, production, collision, homelab]
timestamp: 2026-07-26T20:11:56+00:00
---

# Published-port reservation convention

Production stacks and the CI runner run as two separate rootless Docker daemons **on the same
homelab host**, publishing into the **same host port space**. A prod service binding `0.0.0.0:<port>`
collides with a CI/dev service binding the same port on `127.0.0.1` or `0.0.0.0` — and the collision
manifests as a crash-loop on the *losing* side, not a clean bind error most engineers would expect.

The convention: **every prod admin/UI published port lives in the reserved range `19000–19099`**
(Keycloak admin `19099`, LangFuse `19030`, Grafana/otel-lgtm `19002`, all `0.0.0.0`, tailnet-only via
firewall rules). CI/dev keeps its own separate, lower port numbers. `scripts/check-prod-ci-port-collision.mjs`
is the CI gate that enforces disjointness between the two ranges.

## Gotchas

- **This rule exists because of a real outage, not preemptively.** A prod Keycloak admin bind on a
  port also used by CI collided with a leftover CI Keycloak stack that held the port for several
  hours, crash-looping prod auth. The fix was moving prod's admin/UI ports into the reserved range,
  not just documenting "don't reuse ports."
- **Moving or adding a prod published port also requires updating that port's self-referencing URL
  var** — for example Keycloak's admin-hostname var in the stacks config, or an observability tool's
  own callback URL in its compose file — because the collision gate only scans the `ports:` compose
  key, not those secondary references. Missing this step reintroduces a working port bind pointing at
  a stale self-referencing URL.
- **CI now tears down its stacks on every run** specifically so a leftover CI stack can't hold a port
  indefinitely and starve a prod redeploy the way the original incident did.
- **Port *numbers* as a design convention are fine to discuss; a real host paired with a real port is
  not** — this wiki (and any gate that scans it) treats a literal hostname/tailnet-address next to a
  port number as a topology leak. Discuss the reserved range abstractly, never alongside the
  production hostname.
- **The gate is required in CI** (part of the guardrails the operator checklist runs before/after a
  deploy) — a collision is meant to be caught before it reaches prod, not discovered via an outage.

Full incident narrative, the exact three reserved ports, and the pre/post-fix bind table:
`docs/runbooks/prod-reboot-resilience.md`.
