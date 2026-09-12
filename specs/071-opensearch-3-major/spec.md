# Feature Specification: OpenSearch 2 → 3 for the agent-audit sink

**Feature Branch**: `407-opensearch-3-major`

**Created**: 2026-09-12

**Status**: Draft

**Input**: Backlog item #407 — "Decide the OpenSearch 3 and Langfuse 4 majors deliberately — they are the
only upstream remediation for item #406's advisories". The decision itself is ratified in
[ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md); this feature is the **OpenSearch half**
of it. The Langfuse half is deliberately not in this spec.

## Why now

`opensearchproject/opensearch` carries **two** suppressed Critical advisories, and it is the only image in
the tree for which a single major discharges more than one:

| Advisory | Package | Since | Why no 2.x bump helps |
|---|---|---|---|
| **CVE-2025-14813** | `org.bouncycastle:bcprov-jdk15to18` 1.79 → 1.84 | **feature 035 seed baseline** | 2.19.6 ships `bcprov-jdk15to18-1.79.jar` *alongside* the fixed `bcprov-jdk18on-1.84.jar`; the old jar's presence is the finding |
| CVE-2026-75595 | `io.netty:netty-handler` < 4.1.137.Final | item #406, 2026-09-10 | `opensearch:2` floats to 2.19.6, which resolves to exactly the digest the entry is keyed to; no newer 2.x exists |

CVE-2025-14813 is the important one. It has been suppressed **since the gate was built**, which means the
audit stack has carried a permanent exception for the entire life of the security baseline. Every other
suppression in this repository has been either discharged or re-triaged against a moving upstream; this one
has had nowhere to go. OpenSearch 3 is the first credible destination.

The clock is real but secondary: both entries expire 2026-10-01 and the 14-day warning tier opens
**2026-09-17**. The clock is why this is being decided now; the seed-baseline entry is why the decision is
*upgrade* rather than *re-date*.

## What this feature is NOT allowed to assume

**That OpenSearch 3 actually fixes anything.** Nobody has scanned it. `opensearchproject/opensearch:3`
exists and resolves to 3.8.0 (Docker Hub, pushed 2026-08-04), and that is the entire extent of what is
known.

This repository has already paid for that exact inference. Feature 036 moved
`mongodb-community-server` 8.0.8 → 8.0.26 on the strength of it being newer; the image still bundled a
pre-fix Go binary, cleared the Critical it was chosen for, *and* came up unhealthy on the CI runner. The
revert is why the mongo entry still says "stay on the long-stable 8.0.8".

So **US-1 below is a gate, not a task.** No compose file, renovate rule or allowlist entry moves until it
passes, and a failing gate ends this feature with a re-date instead — the fallback is written into
ADR-0002 §6 so that abandoning is a *recorded* outcome rather than a quiet stall.

## What makes this upgrade cheap, and the thing that would make it expensive

ADR-0002 §4 ratifies that **the production audit store is not preserved across cutover**. The volume is
recreated; there is no snapshot, no restore, and no index-compatibility migration. Rollback is a digest
revert plus a volume recreate.

That single decision is what keeps this feature small, and it has a price that is stated plainly rather than
left to be discovered: **the existing production agent-audit history is discarded**, and the 90-day retention
window ([logging-and-audit](../../openwiki/invariants/logging-and-audit.md)) restarts from the cutover date.

If that ratification is ever reversed, this spec does not merely gain a task — it changes shape. Preserving
the store would add a snapshot/restore path, an index-compatibility check (OpenSearch 3 reads indices
*created* by 2.x, but that is a property to verify against the real indices rather than assume), and a
rollback that is a tested restore rather than a revert.

## User scenarios

### US-1 — The premise is proven before anything moves (P1, GATE)

**As** the person deciding, **I want** `opensearchproject/opensearch:3` scanned with the gate's own criteria
**so that** the upgrade is known to discharge the advisories it is being done for.

**Why this priority**: everything else in this feature is worthless if the answer is no, and cheap to skip if
the answer is no. It is also the only story that can end the feature.

**Independent Test**: run the scan; read the two advisory ids in the output. No other artifact needs to exist.

**Acceptance Scenarios**:

1. **Given** the current `opensearch:3` digest, **When** it is scanned with `--severity CRITICAL
   --ignore-unfixed` (the gate's criteria), **Then** the result explicitly states, per advisory, whether
   CVE-2025-14813 and CVE-2026-75595 are present.
2. **Given** the scan shows **neither** advisory present, **When** the gate is evaluated, **Then** the
   feature proceeds to US-2.
3. **Given** the scan shows **both** still present, **When** the gate is evaluated, **Then** the feature is
   **abandoned**: packageRule 19 keeps `allowedVersions: "<3"`, both entries are re-dated to 2026-12-01 with
   a justification naming the scanned digest and what it bundled, and item #407 is closed against ADR-0002 §6
   rather than against this spec.
4. **Given** the scan shows **exactly one** still present, **When** the gate is evaluated, **Then** the
   outcome is recorded on this spec as an explicit judgement with its reasoning — there is no automatic
   verdict, because a major that halves a permanent suppression may or may not be worth a data loss.

### US-2 — The audit sink runs on OpenSearch 3 in local dev (P1)

**As** a developer, **I want** `docker compose --profile audit up -d` to bring up a healthy OpenSearch 3
**so that** the agent-audit write path can be exercised before production sees it.

**Why this priority**: local is where an unhealthy container is cheap. Feature 036's mongo attempt came up
unhealthy *on CI*, after the image had been chosen.

**Independent Test**: bring the audit profile up on a fresh volume; the healthcheck passes and the
write-only `agent-audit` account can index into `mcm-agent-audit-*`.

**Acceptance Scenarios**:

1. **Given** a fresh `agent-audit-opensearch-data` volume, **When** the audit profile starts, **Then** the
   container reaches healthy within the existing healthcheck's budget.
2. **Given** a healthy container, **When** the write-only `agent-audit` account indexes a document into
   `mcm-agent-audit-*`, **Then** the write succeeds and a **read** or **delete** with that account is still
   refused — the least-privilege split survives the major.
3. **Given** the container is running, **When** its heap is inspected, **Then** the 1 GB
   `OPENSEARCH_JAVA_OPTS` pin is still honoured under OpenSearch 3's newer JDK, so the dev machine does not
   regain a ~4 GB default.
4. **Given** the stack is brought up with no `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, **When** compose
   interpolates, **Then** it still fails fast with the existing `${VAR:?}` message rather than starting
   insecurely.

### US-3 — Production cuts over, and the rollback is exercised rather than described (P1)

**As** the operator, **I want** the `prod-audit` Komodo stack moved to OpenSearch 3 with a rollback that has
been performed at least once **so that** "we can roll back" is a measurement rather than a claim.

**Why this priority**: this is the only step that touches production, and per ADR-0002 §4 it is also
irreversible with respect to data. A rollback path that has never been run is the shape this repository has
been bitten by repeatedly.

**Independent Test**: cut over, confirm writes land, revert to the 2.x digest on a recreated volume, confirm
writes land again.

**Acceptance Scenarios**:

1. **Given** the prod stack on 2.x, **When** the digest moves to 3.x and the volume is recreated, **Then**
   the stack comes up healthy and the gateway's audit writes land in `mcm-agent-audit-*`.
2. **Given** the stack on 3.x, **When** the rollback is exercised, **Then** reverting the digest and
   recreating the volume returns a healthy 2.x stack — and the fact that the data does **not** come back is
   the expected, ratified outcome, not a failure.
3. **Given** cutover has happened, **When** the retention window is next read, **Then** it is understood to
   start at the cutover date.

### US-4 — The suppressions are deleted and the gate proves it (P2)

**As** the person who has carried these entries, **I want** both OpenSearch allowlist entries **deleted**
**so that** a regression re-blocks instead of being silently tolerated.

**Why this priority**: this is the point of the feature. It is P2 only because it is mechanically
downstream of US-1–US-3.

**Independent Test**: delete both entries; a full sweep passes with no un-allowlisted fixable Critical and no
UNMATCHED entry.

**Acceptance Scenarios**:

1. **Given** 3.x is deployed, **When** the two OpenSearch entries are **deleted** (not expired), **Then** the
   infra-image gate passes and `--check-expiring` reports neither as UNMATCHED.
2. **Given** the entries are deleted, **When** either advisory reappears on a future image, **Then** the gate
   **blocks** rather than suppressing.
3. **Given** the allowlist file is edited, **When** CI runs, **Then** a **real** sweep runs rather than a
   2-second skip — `security/infra-images/**` is in the workflow's path filter, which is what makes this
   change self-confirming.

## Requirements

- **FR-001** The US-1 scan MUST run with the gate's own criteria (`--severity CRITICAL --ignore-unfixed`)
  against a **digest**, not a floating `:3` tag, and the digest MUST be recorded in this spec's research
  output. A scan of "whatever `:3` meant that day" cannot be re-checked.
- **FR-002** The scan MUST run where Trivy is authoritative (CI, or a Linux host with Trivy and disk
  headroom). It MUST NOT be run from the dev container by pulling a multi-GB image onto a 92%-full disk.
- **FR-003** No compose file, `renovate.json` rule or allowlist entry may change before FR-001 has produced a
  recorded result.
- **FR-004** Both `infrastructure-as-code/docker/opensearch/compose.yaml` and `compose.prod.yaml` MUST move
  together, version tag **plus digest**, per feature 063 / item #297.
- **FR-005** `renovate.json` packageRule 19's `allowedVersions: "<3"` MUST be removed in the same change that
  moves the image, and its `description` MUST be rewritten to record the outcome rather than deleted — the
  rule's text is the record of why the ceiling existed.
- **FR-006** The write-only `agent-audit` account MUST retain index/bulk on `mcm-agent-audit-*` and MUST
  still be refused read, search and delete. If OpenSearch 3 changes the security-plugin configuration format,
  reproducing this split is in scope; weakening it to get the stack up is not.
- **FR-007** The 1 GB heap pin MUST still take effect. If OpenSearch 3 ignores or renames
  `OPENSEARCH_JAVA_OPTS`, the equivalent MUST be set rather than the pin dropped.
- **FR-008** Both allowlist entries MUST be **deleted**, never re-dated, once 3.x is deployed. An entry
  matching nothing fails `--check-expiring` exactly as an expired one does, and deletion is what restores
  blocking.
- **FR-009** The rollback MUST be **performed** once, not merely documented.
- **FR-010** If the US-1 gate fails, the feature MUST end with the ADR-0002 §6 fallback applied — re-dated
  entries naming the scanned digest — and MUST NOT leave the ceiling lifted or a half-moved compose file.

## Out of scope

- **Langfuse 3 → 4.** Ratified as a separate spec in ADR-0002 §1. Nothing here lifts packageRule 20.
- **Preserving the existing audit data.** Ratified against in ADR-0002 §4. Reversing that is an ADR edit
  first, and it changes this spec's shape rather than adding to it.
- **The other two item #406 majors** (`postgres`, `keycloak` entries) — different images, different rules.
- **Re-keying the `langfuse/*:3` allowlist entries** away from a floating major. That is a real residual
  (item #412 named it), but it belongs to the Langfuse half.

## Success criteria

- **SC-001** The number of seed-baseline suppressions in `security/infra-images/allowlist.yaml` decreases by
  one — the first time that has happened since feature 035.
- **SC-002** A full infra-image sweep passes with both OpenSearch entries **absent** and no UNMATCHED report.
- **SC-003** The prod audit write path is verified working on 3.x by an actual write from the gateway's
  write-only account, not by a healthcheck alone.
- **SC-004** A rollback to 2.x has been executed once and returned a healthy stack.
- **SC-005** Either the ceiling is lifted, or packageRule 19 carries a re-dated justification naming a
  **scanned digest** — never the pre-existing "no newer 2.x exists" reasoning restated.

## Assumptions

- OpenSearch 3 remains a single-node, `discovery.type=single-node` deployment; this feature does not
  introduce clustering.
- Port 9200 stays loopback-bound locally and network-isolated in prod; the major changes no exposure.
- `opensearch:3` floats to 3.8.0 today. The spec pins a digest, so a later 3.x is an ordinary Renovate
  update once the ceiling is lifted.
