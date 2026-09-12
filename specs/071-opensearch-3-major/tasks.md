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

## Phase 1: Prove the privilege split on 2.x, BEFORE the image moves (US-2)

> Written and proven RED/GREEN against **2.x**. A least-privilege test that has only ever run against 3.x
> cannot tell "still correct" from "never checked" — which is the whole reason it exists.

- [ ] **T005** [US2] Write a test asserting the write-only `agent-audit` account **can** index/bulk into
  `mcm-agent-audit-*` and **is refused** read, search and delete. **Verify RED** by pointing it at the admin
  account (which may do all four) — the test must fail for the right reason before it is trusted.
- [ ] **T006** [US2] **Verify GREEN** against the current **2.x** stack. This is the baseline. If it does not
  pass on 2.x, the test is wrong, not the stack.

---

## Phase 2: Local bring-up on OpenSearch 3 (US-2)

- [ ] **T007** [US2] Move `infrastructure-as-code/docker/opensearch/compose.yaml` to the 3.x **tag + digest**
  from T001 (FR-004).
- [ ] **T008** [US2] Recreate `agent-audit-opensearch-data` and bring up `docker compose --profile audit
  up -d`. Confirm the container reaches healthy inside the existing healthcheck budget.
- [ ] **T009** [US2] Re-provision the write-only `agent-audit` account on 3.x and **re-run T005**. If the
  security-plugin configuration format changed, reproducing the split is in scope; weakening it to get a
  green stack is **not** (FR-006).
- [ ] **T010** [P] [US2] Verify the **1 GB heap pin** still binds under OpenSearch 3's newer JDK (FR-007).
  If `OPENSEARCH_JAVA_OPTS` is ignored or renamed, set the equivalent — do not drop the pin. An unpinned
  OpenSearch defaults to ~4 GB on a dev machine already running a large multi-service stack, and no gate
  would catch it.
- [ ] **T011** [P] [US2] Verify the `${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?…}` fail-fast still fires when the
  variable is absent, so a missing secret cannot start an insecure node (US-2 #4).

---

## Phase 3: Production cutover (US-3)

- [ ] **T012** [US3] Move `infrastructure-as-code/docker/opensearch/compose.prod.yaml` to the same tag +
  digest (FR-004 — both files move together).
- [ ] **T013** [US3] Redeploy the `prod-audit` Komodo stack onto a **recreated** volume. Per ADR-0002 §4 the
  existing audit history is discarded at this point and the 90-day retention window restarts from today.
- [ ] **T014** [US3] Verify with an **actual audit write from the gateway's write-only account** into
  `mcm-agent-audit-*` — not with the healthcheck (SC-003). A healthy node with a broken audit role is
  precisely the failure this stack hides, because the writer never reads back.

---

## Phase 4: The rollback drill, then the deletions (US-3, US-4)

- [ ] **T015** [US3] **Perform** the rollback once (FR-009): revert the prod digest to the 2.x pin, recreate
  the volume, confirm a healthy 2.x stack accepting writes. The data not returning is the ratified outcome,
  not a failure. Then roll forward to 3.x again.
- [ ] **T016** [US4] **Delete** — never re-date — both OpenSearch entries from
  `security/infra-images/allowlist.yaml`: the digest-keyed `CVE-2026-75595` entry and the seed
  `CVE-2025-14813` entry (FR-008). An entry matching nothing is reported UNMATCHED and fails
  `--check-expiring` exactly as an expired one does; deletion also restores blocking so a regression
  re-blocks.
- [ ] **T017** [US4] Remove `allowedVersions: "<3"` from `renovate.json` packageRule 19 and **rewrite** its
  `description` to record the outcome — do not delete the text (FR-005). The rule's prose is the record of
  why the ceiling existed and what discharged it.
- [ ] **T018** [US4] Extend `scripts/__tests__/renovate-workflow.guard.test.mjs`: packageRule 19 must
  **either** still hold `<3` **or** name a scanned digest in its description. Both states are legal; silence
  is not. Mutation-test it.
- [ ] **T019** [US4] Confirm CI ran a **real sweep**, not a 2-second skip — editing `security/infra-images/**`
  is in the workflow's path filter, which is what makes this change self-confirming (US-4 #3). Read the job
  **duration from the commit-status description**, never `stopped - started` from `/actions/runs`.
- [ ] **T020** [US4] Confirm `--check-expiring` reports neither deleted entry as UNMATCHED, and that the
  `infra-image-scan/expiry` status (item #418) shows the step actually ran on the next scheduled sweep.

---

## Phase 5: The abandon path (only if T004 said abandon)

> Reached **only** from T004. This is a real outcome, not a failure state, and it is written down so that
> abandoning is recorded rather than the feature quietly stalling.

- [ ] **T021** Leave `allowedVersions: "<3"` in place and leave both compose files on 2.x. FR-010 — no
  half-moved state.
- [ ] **T022** Re-date both OpenSearch allowlist entries to **2026-12-01**, replacing the justification with
  one that names the **scanned 3.x digest** and what it still bundled. SC-005 — never a restatement of the
  existing "no newer 2.x exists" reasoning, which says nothing about 3.
- [ ] **T023** Update [ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md) §3 with the
  measured result and §6 with the new re-triage date, and close item #407 against the ADR rather than
  against this spec.

---

## Dependencies

- **T004 blocks everything.** Phases 1–4 require the "proceed" verdict; Phase 5 requires "abandon".
- T005 → T006 → (T007 → T008 → T009). T006 must pass on **2.x** before T007 moves the image.
- T010, T011 are `[P]` with each other, after T008.
- T012 → T013 → T014 → T015.
- T015 → T016 → T017 → T018 → T019 → T020. The deletions come last because CI proves them.

## Out of scope (restated so it is not rediscovered as a task)

- Langfuse 3 → 4 and `renovate.json` packageRule 20 — a separate spec, per ADR-0002 §1.
- Preserving the audit data — ratified against in ADR-0002 §4; reversing it is an ADR edit that reshapes
  this spec rather than adding a task to it.
- Re-keying the `langfuse/*:3` allowlist entries off their floating major — real (item #412 named it), but
  it belongs to the Langfuse half.
