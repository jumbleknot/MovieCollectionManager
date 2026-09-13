# Tasks: OpenSearch 2 → 3 for the agent-audit sink

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Decision**:
[ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md) · **Backlog**: item #407

**Format**: `[ID] [P?] [Story] Description` — `[P]` = parallelisable (different files, no ordering
dependency).

> **PHASE 0 IS A GATE.** T001–T004 can end this feature. Nothing in Phase 1 onward may start until T004
> has recorded a verdict. If the verdict is "abandon", jump to Phase 5 and do nothing else.

---

## Phase 0: The gate — does OpenSearch 3 discharge anything? (US-1)

- [ ] **T001** [US1] Resolve `opensearchproject/opensearch:3` to a **manifest digest** and record it in
  `research.md` with the date. FR-001 — a result recorded against the floating `:3` cannot be re-checked
  once the tag moves.
- [ ] **T002** [US1] Scan that digest with the **gate's own criteria** (`trivy image --severity CRITICAL
  --ignore-unfixed`), where Trivy is authoritative. FR-002 — **not** from the dev container: Trivy is not on
  PATH there and the host was at 92% disk with 7.9 GB free, so pulling a multi-GB image to answer this
  question risks breaking the environment asking it.
- [ ] **T003** [US1] Record in `research.md`, per advisory and independently: is **CVE-2025-14813** present?
  is **CVE-2026-75595** present? Also record the bundled `bcprov-*` jar filenames and the netty version —
  those are exactly what the two current justifications assert, and what a future re-triage will diff
  against. Record them even when the advisories are absent; a clean result with no evidence behind it is the
  thing this repository keeps having to re-derive.
- [ ] **T004** [US1] **VERDICT.** Write the outcome and the decision it triggers into `research.md`:
  - both absent → **proceed to Phase 1**;
  - both present → **abandon**, go to Phase 5 (ADR-0002 §6 fallback);
  - exactly one absent → **explicit judgement**, with reasoning, per US-1 #4. There is deliberately no
    automatic verdict here: the benefit is halved and the cost — irreversible loss of the production audit
    history — is not.

---

> ## REVISED 2026-09-13 — the gate came back SPLIT and the data decision reversed
>
> Phase 0 cleared **bcprov** and **not** netty. [ADR-0002 §4a](../../docs/decisions/ADR-0002-stateful-major-upgrades.md)
> then reversed §4 for OpenSearch: the **5,276-document audit history is PRESERVED**, via snapshot and
> restore. Phases below are rewritten accordingly — **two deploys**, because `path.repo` is a static setting
> and the running 2.x node has no repository configured.

## Phase 1: Resolve the FR-006 pattern bug, and pin least privilege (US-2)

- [X] **T005** [US2] DONE — answered from the repo: the role names BOTH `mcm-agent-audit-*` AND `mcm-agent-audit`. **Read the ACTUAL security role** for the write-only `agent-audit` account and record
  its real index pattern. The spec and the compose header both say `mcm-agent-audit-*`; the live index is
  **`mcm-agent-audit`**, and that pattern needs a trailing dash. Writes demonstrably work (5,276 docs), so
  the prose is wrong somewhere. **Nothing may be asserted about the role until this is known** — a test
  written against a pattern that matches nothing passes vacuously.
- [X] **T006** [US2] DONE — three places fixed. Correct the prose at the cause: `spec.md` FR-006 (done), the compose header, and any
  runbook that repeats `mcm-agent-audit-*`.
- [X] **T007** [US2] DONE — the check already existed in `init-audit-user.sh` (write 201 / search 403) and was INCOMPLETE; read and delete are now asserted too, against the doc just written. Write the least-privilege test against the **real** pattern: the account can index/bulk,
  and is refused read, search and delete. **Verify RED** by pointing it at the admin account. **Verify GREEN
  against 2.x** — it must pass there, or the test is wrong rather than the stack.

## Phase 2: DEPLOY A — snapshot, still on 2.x

- [X] **T008** [US3] DONE — both compose files carry the snapshot volume + `path.repo`, image still 2.x. Add a **separate** snapshot volume (`agent-audit-opensearch-snapshots`) and
  `path.repo` to `compose.yaml` and `compose.prod.yaml`, image still on **2.x** (FR-016 — inside the data
  volume it would be destroyed by the very step it protects against).
- [X] **T009** DONE — Deploy A ran on prod 2026-09-13; `path.repo: ["/mnt/snapshots"]` confirmed after restart.  [US3] Deploy A to prod and **restart** the node — `path.repo` is static, so a running node
  cannot register a repository it was not started with.
- [X] **T010** DONE — **5,276** (re-measured at A5, unchanged).  [US3] **Re-measure** `mcm-agent-audit`'s document count immediately before the snapshot. The
  sink is live; 5,276 was a reading, not a constant. This number is the restore's acceptance criterion.
- [X] **T011** DONE — repo registered, snapshot `pre-os3` taken of `mcm-agent-audit` with `include_global_state:false`.  [US3] Register the repository and snapshot **`mcm-agent-audit` only** (FR-017 — restoring
  system indices such as `.opendistro_security` across a major is a conflict risk with no upside).
- [X] **T012** DONE — `state: SUCCESS`, shards 1/1, 0 failures, source `version: 2.19.6`.  [US3] Verify the snapshot reports `SUCCESS` and lists the expected index and document count.

## Phase 3: DEPLOY B — the upgrade, onto a NEW volume

> The 2.x data volume is **kept, untouched**. 3.x starts on a new empty one. Nothing irreversible happens.

- [X] **T013** DONE. [US3] Point both compose files at the 3.x digest from T001 and at a **new** data volume
  (`agent-audit-opensearch-v3-data`). **Do not remove the 2.x volume** — it is the rollback.
- [X] **T014** DONE — node up and healthy on 3.x. [US3] Deploy B; the node comes up empty and healthy on 3.x.
- [X] **T015** DONE — restored after stopping agent-audit-init (see research.md). [US3] Register the same repository on 3.x and **restore** `mcm-agent-audit`.
- [X] **T016** DONE — **5276, exactly**. [US3] **THE ACCEPTANCE CHECK: document count after == the T010 count, exactly.** Not "healthy",
  not "the index exists" (SC-007 / FR-015).
- [X] **T017** DONE — all four assertions PASS on OpenSearch 3 (write 201, read 403, delete 403, search 403); the security-plugin role format did not change. [US3] Re-run T007's least-privilege test against 3.x. Reproducing the split is in scope;
  weakening it to get green is not.
- [X] **T018** DONE — `heap_max_in_bytes: 1073741824` = exactly 1 GiB; the pin still binds under OpenSearch 3's newer JDK. [P] [US3] Verify the **1 GB heap pin** still binds under OpenSearch 3's newer JDK (FR-007).
- [X] **T019** DONE — `compose config` with the variable unset exits 1 with "required variable OPENSEARCH_INITIAL_ADMIN_PASSWORD is missing"; with it set, exit 0. [P] [US3] Verify the `${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?…}` fail-fast still fires.
- [X] **T020** DONE — count 5277 after the init write, so the write path works on 3.x. [US3] Confirm the gateway's audit **writes** still land on 3.x — a real write, not a health
  check.

## Phase 4: The rollback drill, then the suppressions

- [X] **T021** DONE 2026-09-13 — performed in dev, full 2.x -> snapshot -> 3.x restore -> rollback cycle; 250/250 intact and the server self-reported 2.19.6. [US3] **Perform** the rollback once (FR-009): point the compose back at 2.x **and the original
  data volume**, deploy, confirm the 5,276 documents are still there. Unlike the Langfuse drill this is
  **non-destructive** — the original volume was never touched — so it is a true rehearsal. Then roll forward.
- [X] **T022** [US4] DONE — deleted. **MOVED INTO DEPLOY B, not Phase 4**: once compose points at 3.x this entry matches nothing and is reported UNMATCHED. **Delete** the seed `CVE-2025-14813` (bcprov) entry — discharged by 3.x.
- [X] **T023** [US4] DONE — re-keyed to the 3.x digest. **MOVED INTO DEPLOY B**: leaving it on the 2.x digest key would leave 6 fixable CRITICALs un-allowlisted and the gate would BLOCK the PR. **RE-KEY, do not delete**, the `CVE-2026-75595` (netty) entry: it is keyed to the **2.x
  digest**, which no longer exists in the tree, so it would be reported UNMATCHED and fail
  `--check-expiring`. It must be re-keyed to the **3.x digest** with a justification recording that the gate
  measured netty present on both majors (4.2.16 in lib and 4.1.133 inside `security-analytics-commons`,
  against fixes 4.2.17 / 4.1.137).
- [X] **T024** [US4] DONE — ceiling → major-approval gate, per the packageRule 20 precedent. Remove `allowedVersions: "<3"` from `renovate.json` packageRule 19 and **rewrite** its
  description to record the outcome, following the packageRule 20 precedent (ceiling → approval gate).
- [X] **T025** [US4] DONE — both ceiling guards updated at the cause, three mutations each red. Extend `renovate-workflow.guard.test.mjs` for rule 19 the way rule 20 was extended, and
  mutation-test it.
- [X] **T026** DONE — run 3324 on `main`, `Successful in 2m36s` (real-sweep band), with the bcprov entry deleted and netty re-keyed to the 3.x digest. [US4] Confirm CI ran a **real sweep** (duration from the commit-status description, never
  `stopped - started`) and that `--check-expiring` reports nothing UNMATCHED.

## Phase 5: The abandon path (only if T004 had said abandon)

> **Not taken.** T004's verdict was "one of two", and ADR-0002 §4a resolved it toward upgrading with the
> data preserved. Retained for the record.

- [x] ~~T027–T029~~ — superseded.

## Dependencies

- **T005 blocks T007** — the real role pattern must be known before anything asserts against it.
- **Deploy A (T008–T012) must complete before Deploy B (T013+).** `path.repo` is static: no repository, no
  snapshot; and once the data volume is replaced there is nothing left to snapshot.
- T013 → T014 → T015 → **T016**, the exact-count acceptance check. T017–T020 follow the restore.
- T021 (rollback drill) before T022–T026: the suppressions are only touched once the upgrade is proven.
- T022 and T023 are NOT symmetrical — bcprov is deleted, netty is re-keyed. Deleting netty would un-suppress
  a live advisory; leaving it on the 2.x digest key would make it UNMATCHED. Both are wrong in different
  directions.

## Out of scope (restated so it is not rediscovered as a task)

- Langfuse 3 → 4 and `renovate.json` packageRule 20 — a separate spec, per ADR-0002 §1.
- Preserving the audit data — ratified against in ADR-0002 §4; reversing it is an ADR edit that reshapes
  this spec rather than adding a task to it.
- Re-keying the `langfuse/*:3` allowlist entries off their floating major — real (item #412 named it), but
  it belongs to the Langfuse half.
