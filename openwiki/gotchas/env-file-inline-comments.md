---
type: Gotcha
title: .env files — no inline comments on value lines
description: dotenv-style loaders (and the Expo CLI) treat everything after = as the literal value, so a trailing inline comment on a KEY=val line becomes part of the secret — this once broke Keycloak login with invalid_client. Comments must go on their own line.
tags: [env-vars, dotenv, config, keycloak, secrets]
timestamp: 2026-07-30T12:34:09-04:00
---

# .env files — no inline comments on value lines

This is a relocated Non-Obvious Design Decision. It has no resource citation because it is
authoritative in its own right — the rule and its rationale live here, not in a linked document.

## Gotcha

**`.env` files — no inline comments on value lines.** dotenv-style loaders (and the Expo CLI) treat
everything after `=` as the value, so `KEY=val # note` yields the literal `val # note` (this surfaced
as Keycloak `invalid_client` when a secret captured its trailing comment). Put comments on their own
lines.

See [Service account vs admin credentials](keycloak-service-account.md) for the Keycloak
client-credentials flow whose secret this class of bug can corrupt, and
[Docker internal DNS](docker-internal-dns.md) for another Keycloak-connectivity gotcha in the same
`.env`-driven configuration surface.
