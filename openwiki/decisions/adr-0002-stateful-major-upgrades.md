---
type: Decision
title: "ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4"
description: Ratifies upgrading OpenSearch 2→3 before Langfuse 3→4, in separate specs, driven by a security clock on four allowlisted CVEs whose only upstream remediation is a major version bump.
resource: docs/decisions/ADR-0002-stateful-major-upgrades.md
tags: [adr, opensearch, langfuse, security, upgrade, decision-record, stateful]
timestamp: 2026-09-12T00:00:00-04:00
---

# ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4

**Status**: Accepted · **Date**: 2026-09-12 · **Feature**: 071-opensearch-3-major (OpenSearch half; Langfuse half not yet specified)

Ratifies upgrading **OpenSearch 2 → 3** first and **Langfuse 3 → 4** afterwards, each in its own
separate spec and pull request. This is not a currency decision — both majors exist to **discharge
CVE allowlist entries whose only upstream remediation is the major itself**, and three of those
entries carry an expiry of 2026-10-01. The 14-day warning tier opens 2026-09-17.

The `renovate.json` packageRule 19 (`opensearchproject/opensearch allowedVersions: "<3"`) is lifted
by feature 071 once the §3 premise gate passes. PackageRule 20 (`langfuse/* < 4`) stands until the
Langfuse spec exists. See the [infra-image scanning runbook](../runbooks/infra-image-scanning.md)
for how the gate and allowlist interact.

## Why OpenSearch goes first

OpenSearch 3 is the **only** one of the two majors that discharges a **seed-baseline** suppression:
CVE-2025-14813 (`bcprov-jdk15to18-1.79.jar`) has been in `security/infra-images/allowlist.yaml`
since the gate was first seeded in feature 035 — it has never been clean. Langfuse 4 also discharges
a CVE (Next.js, CVE-2026-75604), but its blast radius is wider: it sits on Postgres, ClickHouse,
Redis, and MinIO, and a Langfuse major may drag the ClickHouse pin with it. Sequencing the narrower
migration first keeps a red CI signal attributable to a single cause.

## Gotchas

- **The OpenSearch premise has NOT been tested.** The ADR is conditional: nobody has scanned
  `opensearchproject/opensearch:3` with Trivy. The premise is that OpenSearch 3 drops
  `bcprov-jdk15to18-1.79.jar` and carries netty ≥ 4.1.137.Final. If the scan does not clear both
  advisories, the decision reverts to re-dating, not proceeding. This repository was already caught
  by the same inference-without-measurement shape in feature 036 (mongodb-community-server:8.0.26
  was newer, still bundled a pre-fix Go binary, cleared nothing).

- **Do not scan from the dev container or the production host.** As recorded: Trivy is absent from
  PATH in the dev container, and the production host had only ~8 GB free at 92% disk when this was
  written. Pulling a multi-GB image to answer a question CI answers for free risks breaking the
  environment being diagnosed. The §3 gate runs in CI where Trivy lives.
  *Scope note added 2026-09-14:* the PATH observation is true but does not mean the dev container
  cannot scan — Trivy runs there from its own image, and a full 19-image sweep was run that way for
  items #406/#329. **Disk headroom, not the missing binary, is the constraint this ADR turns on**, so
  re-check the headroom rather than citing the binary. The decision itself stands unchanged.

- **Neither production dataset is preserved across cutover — decided explicitly, not defaulted.**
  Both volumes are recreated; rollback is a digest revert plus volume recreate, not a data restore.
  For the OpenSearch audit store this means **the production agent-audit history is discarded at
  cutover**. That store is an append-only security audit trail with a 90-day retention invariant
  (see [logging-and-audit](../invariants/logging-and-audit.md)); after cutover the 90-day
  window restarts from the cutover date and preceding history is gone. If preserving the audit store
  is ever the right call, that is a one-line change in the ADR — but it changes the shape of both
  specs: snapshot/restore steps, tested rollback, and an index-compatibility check before the major
  moves.

- **The two majors must land in separate specs and PRs, not combined.** A combined spec shares one
  CI signal across two unrelated data migrations; a red would not say which half broke. This is the
  same reasoning the [pull-request batching](../process/pull-request-batching.md) convention
  applies to any multi-concern change.

- **Allowlist entries are deleted on landing, not expired.** When OpenSearch 3 lands, both
  OpenSearch entries in `security/infra-images/allowlist.yaml` are deleted rather than given a new
  expiry date. An entry that matches nothing is reported UNMATCHED by `--check-expiring` just as
  an expired one is; deleting also restores blocking, so a regression re-blocks immediately. The
  allowlist edit is self-confirming: touching `security/infra-images/**` forces a real Trivy sweep
  rather than a 2-second path-filter skip.

- **Re-dating is the legitimate fallback, not failure — but it has compounding cost.** If the §3
  premise fails for OpenSearch 3, the correct response is to re-date both OpenSearch entries to
  2026-12-01 with a justification naming the scanned 3.x digest and what it still bundled, then
  re-triage when next chosen. Re-dating is not a bad option; it is one that gets worse each time it
  is chosen, because the seed-baseline entry ages while the argument for moving stays identical.

- **Langfuse 4 may hide a second stateful migration.** If Langfuse 4 requires a ClickHouse or
  Postgres major, that is a second migration inside the first and gets its own research task; the
  Langfuse spec may split again rather than widen. The ADR's revisit trigger covers this.

- **The security clock makes timing non-optional.** A major arriving on a Friday window with a CVE
  argument attached is how a data migration gets waved through. Deciding before the expiry pressure
  peaks (14-day warning opens 2026-09-17) is the point — the spec should land under normal review
  cadence, not under expiry urgency.

Full decision text, rationale table, rejected alternatives, and revisit triggers:
`docs/decisions/ADR-0002-stateful-major-upgrades.md`.
