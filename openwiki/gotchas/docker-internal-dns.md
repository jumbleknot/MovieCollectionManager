---
type: Gotcha
title: Docker internal DNS — BFF reaches Keycloak by service name, never localhost
description: Inside Docker networks the BFF contacts Keycloak at keycloak-service:8080, never localhost. Feature 020 unified the container name and the compose service key to keycloak-service, and cross-stack resolution works over the shared external backend-network.
tags: [docker, dns, keycloak, networking, bff]
timestamp: 2026-07-30T12:34:09-04:00
---

# Docker internal DNS — BFF reaches Keycloak by service name, never localhost

This is a relocated Non-Obvious Design Decision. It has no resource citation because it is
authoritative in its own right — the rule and its rationale live here, not in a linked document.

## Gotcha

**Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks,
not `localhost` (feature 020 unified the container+service-key to `keycloak-service`; cross-stack
resolution works over the shared external `backend-network`).

See [Service account vs admin credentials](keycloak-service-account.md) for how the BFF authenticates
once it reaches Keycloak over this internal address, and
[.env files — no inline comments](env-file-inline-comments.md) for another gotcha in the same
`.env`-driven Keycloak configuration surface.
