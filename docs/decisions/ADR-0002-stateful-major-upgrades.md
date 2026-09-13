# ADR-0002 — The OpenSearch 3 and Langfuse 4 Majors

**Status**: Accepted
**Date**: 2026-09-12
**Feature**: 071-opensearch-3-major (OpenSearch half); the Langfuse half is not yet specified
**Deciders**: Steven Watson
**Supersedes / relates to**: item #407 (this decision), item #406 (the four allowlist entries whose only
remediation is a major), feature 035 (the infra-image gate and its seed baseline), feature 063 / item #297
(version+digest pinning, and why a key must be dischargeable), `renovate.json` packageRules 19 and 20 (the
two version ceilings this ADR exists to lift), [infra-image scanning runbook](../runbooks/infra-image-scanning.md).

---

## 1. Decision

**Upgrade both. OpenSearch 2 → 3 first, Langfuse 3 → 4 after it has landed.**

The two majors are discharged by **separate specs at separate times**, not by one change. This is not a new
position — `renovate.json` packageRule 20 already states it as the reason the two ceilings are two rules
rather than one `matchPackageNames` list. This ADR ratifies it rather than re-deciding it.

OpenSearch goes first because it is the only one of the two that discharges a **seed-baseline** suppression,
and because Langfuse 4 has a wider blast radius — it sits on Postgres, ClickHouse, Redis and MinIO, and a
major there may drag the ClickHouse pin with it. Sequencing the narrow one first keeps a red signal
attributable.

---

## 2. Why this is a security decision with a clock, not a currency nicety

Item #406 (2026-09-10) allowlisted four images whose **only** upstream remediation is a major version. Two of
them are these:

| Image | Pinned at | Advisory suppressed | Discharged by |
|---|---|---|---|
| `opensearchproject/opensearch` | `2` → 2.19.6, digest-pinned | CVE-2026-75595 (io.netty) | major 3 |
| `opensearchproject/opensearch` | as above | **CVE-2025-14813** (org.bouncycastle `bcprov-jdk15to18` 1.79) | major 3 |
| `langfuse/langfuse` + `-worker` | `3` (2026-09-02 build) | CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 (Next.js) | major 4 |

CVE-2025-14813 has been a **seed baseline entry since feature 035**. The audit stack has therefore carried a
permanent suppression for as long as the gate has existed, and OpenSearch 3 is the first credible chance to
remove it rather than re-date it. That is the single strongest argument in this document, and it applies to
exactly one of the two majors.

The three item #406 entries carry `expiry: 2026-10-01`. The 14-day warning tier opens **2026-09-17**. The
point of deciding now is that a major arriving on a Friday window with a CVE argument attached is how a data
migration gets waved through — see §7.

---

## 3. The premise, stated so it can be falsified

**This decision is conditional, and the condition has NOT been tested.**

Nobody has scanned `opensearchproject/opensearch:3`. The tag exists and resolves to 3.8.0 (Docker Hub,
2026-08-04), but existence is not remediation, and this repository has already been caught by exactly that
inference once: feature 036 tried `mongodb-community-server:8.0.26`, which was newer, still bundled a pre-fix
Go binary, and cleared nothing. The current OpenSearch justification records the same shape — 2.19.6 ships
`bcprov-jdk15to18-1.79.jar` *alongside* the newer `bcprov-jdk18on-1.84.jar`, so the old jar's mere presence
is what keeps the finding alive.

So the premise is: **OpenSearch 3 drops `bcprov-jdk15to18` 1.79 and carries netty ≥ 4.1.137.Final.**

It is tested **before** any compose file moves, with the gate's own criteria, in CI where Trivy lives. If the
scan clears **neither** advisory, this decision reverts to §6 for OpenSearch and no migration work is done.
If it clears **one**, that is a judgement call recorded on the spec, not an automatic go.

Trivy is deliberately not run from the dev container for this: it is absent from PATH there, and the host had
7.9 GB free at 92% disk when this was written — pulling a multi-GB image to answer a question CI answers for
free is how a diagnosis breaks the environment it is diagnosing.

---

## 4. Ratified consequence: neither production dataset is preserved across cutover

**Decided explicitly, not defaulted.** Neither the production OpenSearch audit store nor the production
Langfuse trace store must survive its upgrade. Both volumes are recreated; there is no snapshot/restore step,
and rollback is a digest revert plus a volume recreate rather than a data restore.

This is what makes both upgrades cheap, and it is the load-bearing assumption of both specs. It is written
here rather than buried in a plan because of what it costs:

> **The production agent-audit history is discarded at cutover.** That store is an append-only *security*
> audit trail with a 90-day retention invariant
> ([logging-and-audit](../../openwiki/invariants/logging-and-audit.md)); after cutover the 90-day window
> restarts from the cutover date and the preceding history is gone. The same applies to production Langfuse
> traces, which carry no such invariant and are the easier half of this consequence.

If that is ever the wrong trade, it is a one-line change *here* — and it changes the shape of both specs, not
just a task in them: preserving the audit store turns rollback from a revert into a tested restore, and adds
an index-compatibility step before the major can move.

---

## 4a. AMENDED 2026-09-13 — the OpenSearch audit store IS preserved

**§4 above stands for Langfuse and is superseded for OpenSearch.** It was ratified without anyone knowing
what the audit store contained. Measured 2026-09-13: **5,276 documents, 326.9 kb** in `mcm-agent-audit`.

Two things changed the trade:

- **The benefit halved.** The Phase 0 gate cleared CVE-2025-14813 (bcprov) and **not** CVE-2026-75595
  (netty), which is present on 2.x and 3.x alike — see `specs/071-opensearch-3-major/research.md`.
- **The cost became knowable, and the mitigation cheap.** The earlier "preserving is a feature in its own
  right" assessment assumed an unknown, possibly large dataset. At 326.9 kb a snapshot/restore is
  verifiable by **exact document count**, and upstream lists snapshot-and-restore as a supported *upgrade
  method* across adjacent majors.

**Decision: OpenSearch 3 is taken with the audit history preserved via snapshot and restore.** The Langfuse
half already completed under §4 as written and is unaffected.

> The number was nearly not measured at all. `_cat/indices/mcm-agent-audit-*` returned an empty result —
> the pattern needs a trailing dash and the real index is `mcm-agent-audit` — and that empty result was one
> step from justifying the destruction of a security audit trail. **A zero from a filtered query means "no
> match", not "no data".** Recorded here, not just in the spec, because it nearly changed a ratified
> decision on false evidence.

**Scope of the preservation: `mcm-agent-audit` only.** The `security-auditlog-*` and `top_queries-*`
indices are plugin-generated telemetry that regenerates, and restoring system indices such as
`.opendistro_security` across a major is a conflict risk with no upside.

## 5. What was rejected, and why

**Upgrade only one of the two.** Rejected as a standing position, though it is the *interim* state by
construction, since they land separately. Taking OpenSearch alone leaves the Next.js advisory suppressed
under a key (`langfuse/langfuse:3`) that matches every 3.x that will ever exist and so cannot be discharged
by an upgrade — the un-dischargeable-key shape item #297 removed elsewhere. Taking Langfuse alone leaves the
suppression that has been open longest.

**Stay on both and re-date.** Rejected, but it remains the fallback in §6 and it is not a bad option — it is
simply one that gets worse each time it is chosen, because the seed-baseline entry ages while the argument
for moving stays identical. Re-dating is a decision to pay the same cost later; it should be taken because
the premise in §3 failed, not because the window was inconvenient.

**One combined spec for both majors.** Rejected. Two unrelated data migrations on one branch share one CI
signal, and a red would not say which half broke — the exact ambiguity
[PR batching](../../openwiki/process/pull-request-batching.md) says to split on.

---

## 6. Revisit trigger and the fallback

This ADR is revisited when any of these holds:

- **The §3 premise fails for OpenSearch 3.** Fallback: keep `allowedVersions: "<3"` on packageRule 19, and
  re-date both OpenSearch entries to **2026-12-01** with a justification naming the scanned 3.x digest and
  what it still bundled. Re-triage then, against whatever 3.x is current.
- **Langfuse 4 requires a ClickHouse or Postgres major.** That is a second stateful migration hiding inside
  the first; it gets its own research task and may split the Langfuse spec again rather than widen it.
- **Either advisory is remediated upstream on the current major.** Then the corresponding entry is deleted
  and the upgrade loses its security argument, reverting to an ordinary currency decision with no clock.

---

## 7. Consequences

- `renovate.json` packageRule 19 (`opensearchproject/opensearch` `allowedVersions: "<3"`) is lifted by
  feature 071, not before, and only after the §3 gate passes. PackageRule 20 (`langfuse/*` `< 4`) stands
  until the Langfuse spec exists.
- Both OpenSearch entries in `security/infra-images/allowlist.yaml` — the digest-keyed CVE-2026-75595 entry
  and the seed CVE-2025-14813 entry — are **deleted**, not expired, when 3.x lands. An entry that matches
  nothing is reported UNMATCHED and fails `--check-expiring` just as an expired one does; deleting also
  restores blocking, so a regression re-blocks. Same reasoning as `f7fea0f6`.
- The allowlist edit is self-confirming: `security/infra-images/**` is in the infra-image-scan path filter,
  so touching it forces a **real** sweep rather than a 2-second skip.
- Until both halves land, item #406's entries stay as they are. This ADR does not re-date anything; it
  records why they are expected to be **deleted** rather than extended.
