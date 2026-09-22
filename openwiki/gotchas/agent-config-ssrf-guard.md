---
type: Gotcha
title: SSRF guard must check the canonicalized IP, not the hostname string
description: A user-supplied Ollama base URL is fetched server-side, so it must be checked for link-local and cloud-metadata targets — but WHATWG URL canonicalization rewrites IPv4-mapped IPv6 literals to a hex form that a naive dotted-decimal regex never matches.
tags: [ssrf, security, bff, agent-config]
timestamp: 2026-06-19T16:36:33-04:00
---

# SSRF guard must check the canonicalized IP, not the hostname string

Feature 018's "bring your own Ollama" lets a user point the agent at their own model server, and
the BFF fetches that URL server-side at save time and at connection-probe time — a classic SSRF
shape. `frontend/mcm-app/src/bff-server/agent-config-ssrf.ts` enforces the policy: allow
private/loopback addresses (the whole point of BYO-Ollama), but always block link-local and
cloud-metadata addresses (`169.254.0.0/16`, IPv6 `fe80::/10`, and the AWS IMDS-over-IPv6 address),
plus an optional `AGENT_OLLAMA_ALLOWED_HOSTS` allowlist for hardened multi-user deployments.

## Gotchas

- **The dotted-decimal regex alone is dead code against a real bypass.** `new URL()` (WHATWG)
  canonicalizes an IPv4-mapped IPv6 literal — `http://[::ffff:169.254.169.254]/` becomes hostname
  `::ffff:a9fe:a9fe` (hex), not the dotted form. A check like `/^::ffff:169\.254\./` over
  `URL.hostname` never fires against that canonicalized value, and the cloud-metadata address slips
  the block entirely. The fix (`mappedIpv4()`) de-maps *both* the dotted (`::ffff:a.b.c.d`) and the
  canonical hex (`::ffff:HHHH:HHHH`) forms back to the embedded IPv4 before applying the link-local
  range check.
- **This is enforced twice for a reason.** The check runs at save (`validateOllamaUrl`) *and* again
  at probe time, and the probe additionally uses `redirect: 'manual'` — a URL that passed the save
  check could otherwise 30x-redirect to a blocked target at request time.
- **The guard is a BFF-only, DNS-blind check — this is a documented residual risk, not an
  oversight.** It validates the literal host string; it does not resolve DNS, so a hostname that
  resolves to a link-local/metadata address at request time is not caught (DNS rebinding). It also
  does not cover the Python `ChatOllama` runtime fetch inside the agent gateway, which is entirely
  unguarded. `AGENT_OLLAMA_ALLOWED_HOSTS` is the recommended mitigation for genuinely hostile
  multi-user deployments, not the canonicalization fix itself.

See [BFF](../projects/bff.md) for where this guard sits in the request path, and
[Agent Gateway](../projects/agent-gateway.md) for the unguarded runtime fetch this guard does
not reach.

## A second, different guard now exists — do not assume one covers both

Feature 073 (per-user collection backups) added its own destination guard in
`backup-destination-url-guard.ts`. **It is not this one, and neither supersedes the other.** The
difference matters at review time, because "the SSRF guard" is now ambiguous:

| | Ollama guard (this page) | Backup destination guard |
|---|---|---|
| Resolves DNS | **No** — literal host string only | **Yes**, and pins the connection to the resolved address |
| Default for private addresses | Allowed (a homelab Ollama is normally on the LAN) | **Denied**, unless explicitly allow-listed |
| Rebinding between check and use | Not covered — the documented residual risk above | Covered by connection pinning |

So the DNS-blindness recorded above is **still true of the Ollama path** and was *not* fixed by
feature 073. A reader who sees "backups resolve and pin" and concludes the agent config path does
too would be wrong, which is the whole reason this section exists.

The two policies differ because the threats do. An Ollama base URL is *expected* to be private —
denying private addresses would break the ordinary case. A backup destination is expected to be
remote storage the user owns, so private is the suspicious case and must be opted into.

Closing the Ollama gap — and the entirely unguarded Python `ChatOllama` fetch — is tracked as a
follow-up, not done here. See [the backups runbook](../../docs/runbooks/backups.md).
