---
type: Decision
title: "ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4"
description: Derived summary of the ratified decision to upgrade OpenSearch 2→3 before Langfuse 3→4 in separate specs, as landed on 2026-09-13 — both ceilings lifted, the §3 gate measured, and the audit store preserved under the §4a amendment.
resource: docs/decisions/ADR-0002-stateful-major-upgrades.md
tags: [adr, opensearch, langfuse, security, upgrade, decision-record, stateful]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T10:29:14.990Z
sources:
  - id: openwiki-source-45464ccea280daa5176a3646
    resource: repo://agents/movie-assistant/src/audit_sink.py
  - id: openwiki-source-a32b06ef0f76afb80af4d88a
    resource: repo://docs/decisions/ADR-0002-stateful-major-upgrades.md
  - id: openwiki-source-7c76000f237dd683a4fb0536
    resource: repo://docs/runbooks/infra-image-scanning.md
  - id: openwiki-source-8e2135ee1e81e6877b010809
    resource: repo://infrastructure-as-code/docker/observability/compose.prod.yaml
  - id: openwiki-source-cc2828785988d51226a4241e
    resource: repo://renovate.json
  - id: openwiki-source-4708763005c35901b04f5740
    resource: repo://security/infra-images/allowlist.yaml
  - id: openwiki-source-0142cec1b04f10ba9cda1285
    resource: repo://specs/071-opensearch-3-major/research.md
  - id: openwiki-source-c3e8d381767b446d4f50d6f6
    resource: repo://specs/072-langfuse-4-major/research.md
  - id: openwiki-source-c8fd59e28a7d780b80a80bd7
    resource: repo://specs/072-langfuse-4-major/spec.md
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4

**Status**: Accepted, as amended by §4a · **Date**: 2026-09-12 · **Features**: 071-opensearch-3-major and 072-langfuse-4-major — both halves landed 2026-09-13

Ratifies upgrading **OpenSearch 2 → 3** first and **Langfuse 3 → 4** afterwards, each in its own
separate spec and pull request. This is not a currency decision — both majors exist to **discharge
CVE allowlist entries whose only upstream remediation is the major itself**, and three of those
entries carry an expiry of 2026-10-01. The 14-day warning tier opens 2026-09-17.

Both halves have since landed: feature 071 (OpenSearch 3) and feature 072 (Langfuse 4, carrying the
ClickHouse major it drags with it). The `renovate.json` packageRule 19 ceiling
(`opensearchproject/opensearch allowedVersions: "<3"`) and packageRule 20's `langfuse/* < 4` ceiling
are both gone, each replaced by a `dependencyDashboardApproval` requirement on the next major — the
ADR's "not by accident" expressed as config. See the
[infra-image scanning runbook](../runbooks/infra-image-scanning.md) for how the gate and allowlist
interact.

## Why OpenSearch goes first

OpenSearch 3 is the **only** one of the two majors that discharges a **seed-baseline** suppression:
CVE-2025-14813 (`bcprov-jdk15to18-1.79.jar`) has been in `security/infra-images/allowlist.yaml`
since the gate was first seeded in feature 035 — it has never been clean. Langfuse 4 also discharges
a CVE (Next.js, CVE-2026-75604), but its blast radius is wider: it sits on Postgres, ClickHouse,
Redis, and MinIO, and a Langfuse major may drag the ClickHouse pin with it. Sequencing the narrower
migration first keeps a red CI signal attributable to a single cause. That second prediction held
literally — see the ClickHouse gotcha below.

## Gotchas

- **The OpenSearch premise has NOT been tested.** The ADR is conditional: nobody has scanned
  `opensearchproject/opensearch:3` with Trivy. The premise is that OpenSearch 3 drops
  `bcprov-jdk15to18-1.79.jar` and carries netty ≥ 4.1.137.Final. If the scan does not clear both
  advisories, the decision reverts to re-dating, not proceeding. This repository was already caught
  by the same inference-without-measurement shape in feature 036 (mongodb-community-server:8.0.26
  was newer, still bundled a pre-fix Go binary, cleared nothing).
  *Outcome note added 2026-09-13 — the paragraph above is the reasoning as ratified, left intact.*
  The gate cleared **one** of the two — CVE-2025-14813 (bcprov) is gone, CVE-2026-75595
  (netty) is present on 3.x exactly as on 2.x, six findings each. That is the ADR's explicit "clears
  one" branch, a judgement recorded on the spec rather than an automatic go — and the judgement was
  not re-dating, because §4a (below) removed the reason the halved benefit looked unacceptable. The
  discharge is structural rather than a version bump: 3.x ships the `bc-fips-*` distribution and the
  old provider jar is absent. The Langfuse half ran the same gate and passed clean, with the bundled
  Next.js at exactly the fixed version.

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
  **That one line was changed, on 2026-09-13 — §4a supersedes §4 for OpenSearch only.** Measured
  before the decision rather than assumed: `mcm-agent-audit` held **5,276 documents / 326.9 kb**
  (the index name has no date suffix, and `security-auditlog-*` / `top_queries-*` belong to plugins
  and are not in scope). Two things moved the trade — the benefit **halved** (bcprov discharged,
  netty not), and the cost became knowable and cheap: at that size the restore is verifiable by
  **exact document count**, and upstream lists snapshot-and-restore as a supported upgrade method
  across adjacent majors. The Langfuse half is unaffected and **completed under §4 as written**: its
  trace store was not preserved, and the rollback drill confirms the data not returning is the
  ratified outcome rather than a failure. Preserving the store also **changed the shape of the
  OpenSearch spec**, exactly as §4 predicted: a snapshot repository, a staged restore, a rollback
  still available because the old volume is never touched, and an acceptance count that must
  reproduce 5,276 document-for-document.

- **A zero from a filtered query means "no match", not "no data".** `_cat/indices/mcm-agent-audit-*`
  returned an empty result — the pattern needs a trailing dash and the real index is
  `mcm-agent-audit` — and that empty result was one step from justifying the destruction of a
  security audit trail. It is recorded in the ADR, not just the spec, because it nearly changed a
  ratified decision on false evidence.

- **The two majors must land in separate specs and PRs, not combined.** A combined spec shares one
  CI signal across two unrelated data migrations; a red would not say which half broke. This is the
  same reasoning the [pull-request batching](../process/pull-request-batching.md) convention
  applies to any multi-concern change. Realised as features 071 and 072, each with its own research,
  gate, spec and cutover — and each with its own cutover-day operator corrections.

- **Allowlist entries are deleted on landing, not expired.** When a major lands, the entries it
  discharges in `security/infra-images/allowlist.yaml` are deleted rather than given a new
  expiry date. An entry that matches nothing is reported UNMATCHED by `--check-expiring` just as
  an expired one is; deleting also restores blocking, so a regression re-blocks immediately. The
  allowlist edit is self-confirming: touching `security/infra-images/**` forces a real Trivy sweep
  rather than a 2-second path-filter skip.
  **On landing the two OpenSearch entries split rather than both being deleted.** The seed bcprov
  entry was **deleted** — 3.x really did discharge it. The netty entry was **re-keyed** from the 2.x
  digest to the 3.x digest, because deleting it would have un-suppressed a live finding while leaving
  it on the 2.x key would have reported it UNMATCHED; both moves are wrong in opposite directions.
  Both `langfuse/*` entries were deleted at the 072 cutover, because that major *was* the
  remediation. The rule is unchanged: delete rather than renew, and let a regression re-block.

- **Re-dating is the legitimate fallback, not failure — but it has compounding cost.** If the §3
  premise fails for OpenSearch 3, the correct response is to re-date both OpenSearch entries to
  2026-12-01 with a justification naming the scanned 3.x digest and what it still bundled, then
  re-triage when next chosen. Re-dating is not a bad option; it is one that gets worse each time it
  is chosen, because the seed-baseline entry ages while the argument for moving stays identical.
  It was not the branch taken: the gate cleared one of two advisories and §4a resolved the trade by
  preserving the data instead. The surviving netty entry was nonetheless **renewed** to 2026-12-01
  after a fresh scan — a renew is owed a re-measurement, not a new date.

- **Langfuse 4 may hide a second stateful migration.** If Langfuse 4 requires a ClickHouse or
  Postgres major, that is a second migration inside the first and gets its own research task; the
  Langfuse spec may split again rather than widen. The ADR's revisit trigger covers this.
  **It did.** Langfuse 4 requires ClickHouse 25, and feature 072 carries `24.3 → 25.12` in the same
  change. It **widened rather than split**, for one reason that is not a judgement call: Langfuse 4
  on ClickHouse 24 is a state nobody would deliberately run, and ClickHouse 25 under Langfuse 3 is
  an unreviewed combination upstream does not ship — so the two cannot land separately. Widening was
  safe only because of §4: recreating the volumes collapsed a multi-major ClickHouse migration into
  a container swap. `postgres` stayed on **16**, deliberately: `langfuse-postgres` and
  `unleash-postgres` pin the same digest, and Unleash's store is not covered by §4's disposability
  ratification, so a Postgres major would have needed its own mandate.

- **The Langfuse major broke a verification, not just an image.** Langfuse 4 removes
  `GET /api/public/traces` (404) — precisely the endpoint the SC-008 integration test polled for
  per-turn cost and latency, and the reason that spec's original "no application code changes" claim
  was false. The read path moved to
  `observations.get_many(session_id=…, is_root_observation=True)` **with explicit `fields`**, because
  v4's observations API uses sparse fieldsets and `usage` is not in the default set: a syntactically
  correct migration returned real turns with real latency while reporting `cost_usd=None`, which
  reads as "the model wasn't priced" rather than "the field wasn't requested". A guard test can catch
  a reference to a *removed* API; only running the real test against real turns caught this.

- **The security clock makes timing non-optional.** A major arriving on a Friday window with a CVE
  argument attached is how a data migration gets waved through. Deciding before the expiry pressure
  peaks (14-day warning opens 2026-09-17) is the point — the spec should land under normal review
  cadence, not under expiry urgency.

Full decision text, rationale table, rejected alternatives, and revisit triggers:
`../../docs/decisions/ADR-0002-stateful-major-upgrades.md`. The two halves:
`../../specs/071-opensearch-3-major/research.md` and
`../../specs/072-langfuse-4-major/spec.md`.
