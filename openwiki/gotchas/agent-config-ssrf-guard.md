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
- **The guard RESOLVES the name — it was DNS-blind until item #542, and older notes say so.** It
  now resolves the host, checks **every** answer (not `answers[0]` — a record mixing one public and
  one blocked address is the shape that defeats a first-answer check), and the probe connects over a
  socket **pinned** to those answers, so the resolver cannot be asked a second time between the
  check and the connection. The check runs at save **and** at use, which is what catches a name that
  was benign when saved and is not by the time a request is made.
- **Loopback is permitted only on the Ollama port, not blanket-allowed.** Inside a container
  loopback is *this server*, not the user's machine, so an unrestricted allowance let a user-supplied
  URL address whatever else was listening locally. `AGENT_OLLAMA_LOOPBACK_PORTS` (default `11434`)
  is the control; an empty value denies loopback outright. Private and LAN addresses are still
  allowed unconditionally — that part of the policy is unchanged and is the point of BYO-Ollama.
- **`ipaddress.IPv6Address("::1").is_reserved` is `True` in Python — order the loopback check
  FIRST.** IPv6 loopback sits inside a reserved block, so a `is_reserved` test placed above the
  loopback rule silently blocks every `::1` URL, including the default `http://localhost:11434`
  once `localhost` resolves to `::1` first. Measured: it broke two tests in `movie-assistant`
  before the ordering was corrected.
- **The gateway checks too, and it is NOT redundant.** The per-user `ollamaBaseUrl` reaches the
  agent gateway as `OLLAMA_BASE_URL` (`models.runtime_env`) and is handed to `ChatOllama`, which
  opens the connection from *that* process. `src/ollama_guard.py` re-resolves and re-checks there,
  because a check performed in the BFF happened in a different process and possibly days earlier
  and cannot speak for what the name resolves to now.

See [BFF](../projects/bff.md) for where this guard sits in the request path, and
[Agent Gateway](../projects/agent-gateway.md) for the unguarded runtime fetch this guard does
not reach.

## A second, different guard now exists — do not assume one covers both

Feature 073 (per-user collection backups) added its own destination guard in
`backup-destination-url-guard.ts`. **It is not this one, and neither supersedes the other.** The
difference matters at review time, because "the SSRF guard" is now ambiguous:

| | Ollama guard (this page) | Backup destination guard |
|---|---|---|
| Resolves DNS | **Yes** (since item #542), checking every answer | **Yes**, checking every answer |
| Default for private addresses | **Allowed** (a homelab Ollama is normally on the LAN) | **Denied**, unless explicitly allow-listed |
| Loopback | Allowed only on `AGENT_OLLAMA_LOOPBACK_PORTS` (default 11434) | Denied unless allow-listed |
| Rebinding between check and use | Covered in the BFF by pinning; see the gateway caveat below | Covered by connection pinning |

The two now share their *mechanism* and still differ in their *policy*, which is the distinction
worth holding on to. `createPinnedAgent` was moved out to `pinned-agent.ts` in item #542 so both can
use it; that module is deliberately policy-free, and `backup-destination-url-guard.ts` re-exports it
for its own callers. Deciding *which addresses are acceptable* remains each guard's own business.

The two policies differ because the threats do. An Ollama base URL is *expected* to be private —
denying private addresses would break the ordinary case. A backup destination is expected to be
remote storage the user owns, so private is the suspicious case and must be opted into.

## What is still NOT covered

Item #542 closed the DNS-blindness and the unguarded gateway fetch. One residual risk remains, and
it is named here rather than left for a reader to discover:

**The gateway validates but does not PIN.** `src/ollama_guard.py` resolves and checks; `ChatOllama`
then builds its own HTTP client, so the resolver is consulted again when the socket opens. That
leaves a sub-second TOCTOU window in the gateway that the BFF path does not have. It is far smaller
than the save-to-use gap that was closed — which could be days — but it is not zero. Closing it
means pinning the httpx transport inside `langchain-ollama`, which was judged not worth the coupling
until something needs it to be zero.

See [the backups runbook](../../docs/runbooks/backups.md) for the destination guard's own story.
