# Tasks: Langfuse 3 → 4, and the ClickHouse major it brings with it

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Decision**:
[ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md) · **Backlog**: item #433

**Format**: `[ID] [P?] [Story] Description` — `[P]` = parallelisable.

> **PHASE 0 IS A GATE.** T001–T004 can end this feature. Nothing in Phase 1 onward may start until T004 has
> recorded a verdict. If the verdict is "abandon", jump to Phase 5.

---

## Phase 0: The gate — does Langfuse 4 discharge the advisory? (US-1)

- [X] **T001** [US1] Resolve `langfuse/langfuse:4` and `langfuse/langfuse-worker:4` to **manifest digests**
  on **Docker Hub** (FR-006 — not `docker.langfuse.com`) and record them in `research.md` with the date.
- [X] **T002** [US1] Scan both digests with the gate's own criteria (`trivy image --exit-code 1 --severity
  CRITICAL --ignore-unfixed`).
  **Set `TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2` if running locally** — `mirror.gcr.io` is
  unreachable from the dev container and Trivy exits **1** on a DB-download failure, which is
  indistinguishable from findings if only the exit code is read (measured 2026-09-13, item #436). Here that
  mistake reads as "the gate failed, abandon the feature".
- [X] **T003** [US1] Record per image: is **CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4** present? Also record the
  bundled **Next.js version** — that is what the current justification asserts and what a re-triage would
  diff against. Record it even when the advisory is absent.
- [X] **T004** [US1] **VERDICT** in `research.md`:
  - absent from both → **proceed to Phase 1**;
  - still present → **abandon**, go to Phase 5;
  - a *different* blocking Critical appears in 4.x → a recorded finding with reasoning, **not** an automatic
    abandon and **not** a silent allowlist entry (US-1 #4).

---

## Phase 1: The Postgres tripwire, written BEFORE anything moves (US-2)

> FR-005's guard, first — because a single find-and-replace on the shared `postgres:16-alpine` digest moves
> `unleash-postgres` too, silently, and Unleash's data is **not** covered by ADR-0002 §4.

- [X] **T005** [US2] Write a guard asserting that in **both** `compose.yaml` and `compose.prod.yaml`,
  `langfuse-postgres` and `unleash-postgres` reference the **same** image and that it is a `16-` tag.
  **Verify RED** twice: move one reference off 16 (must fail), and make the two disagree (must fail).
- [X] **T006** [US2] **Verify GREEN** against the current tree.

---

## Phase 2: Local bring-up on Langfuse 4 + ClickHouse 25 (US-2)

- [X] **T007** [US2] Move all three images in `compose.yaml` to tag + digest: `langfuse/langfuse:4`,
  `langfuse/langfuse-worker:4`, `clickhouse/clickhouse-server:25.12` (FR-004). Leave `postgres` and `redis`
  untouched.
- [~] **T008** [US2] PARTIAL — see research.md "Phase 1–2". ClickHouse 25.12 / Postgres 16 / Redis 7 verified healthy on fresh volumes in an isolated throwaway; langfuse-web/worker did NOT start there (throwaway MinIO uid artifact), so Langfuse 4 migrations are unwatched. Recreate the `langfuse-postgres`, `langfuse-clickhouse` and MinIO volumes, bring the
  stack up, and confirm every service reaches healthy and Langfuse's migrations complete.
- [ ] **T009** [US2] Assert the ten `LANGFUSE_INIT_*` keys re-seeded org / project / user / API keys with
  **no operator UI step** (US-2 #2). The entire cheapness of this migration rests on this being true, so it
  is asserted rather than assumed.
- [ ] **T010** [US2] Drive a **real agent turn** and confirm the trace appears in Langfuse 4 — this proves
  the gateway's existing credentials still authenticate against 4.x.
- [X] **T011** [P] [US2] Confirm `postgres` is still **16** and `unleash-postgres` is untouched — T005's
  guard passing, plus Unleash still serving its flags.

---

## Phase 3: Production cutover (US-3)

- [X] **T012** [US3] Move the same three images in `compose.prod.yaml` (FR-004).
- [ ] **T013** [US3] Redeploy `prod-observability` onto **recreated** volumes. Per ADR-0002 §4 the existing
  production trace history is discarded at this point.
- [ ] **T014** [US3] Verify with an **actual trace from a real turn** (SC-002), not container health — a
  healthy Langfuse that rejects the gateway's credentials is exactly what this stack would otherwise hide.

---

## Phase 4: Rollback drill, then the ceiling and the deletions (US-3, US-4)

- [ ] **T015** [US3] **Perform** the rollback once (FR-010): revert all three prod digests, recreate the
  volumes, confirm a healthy 3.x / 24.3 stack accepting traces. The data not returning is the ratified
  outcome, not a failure. Then roll forward.
- [X] **T016** [US4] **Delete** both `langfuse/*` entries from `security/infra-images/allowlist.yaml`
  (FR-009). They were re-keyed from the floating `:3` major to their pinned digests ahead of this feature
  (item #407 / item #412 residual), so they stop matching the moment the pin moves — deletion is the
  bookkeeping that follows, and it is what restores blocking.
- [X] **T017** [US4] NO-OP, checked: no allowlist entry names clickhouse at all. Re-key or drop any entry whose key names `clickhouse…24.3` (FR-008) — an
  entry must not outlive the image it describes.
- [X] **T018** [US4] Remove `allowedVersions: "<4"` from `renovate.json` packageRule 20 and **rewrite** its
  description to record the outcome; do not delete the text (FR-007).
- [X] **T019** [US4] Extend `renovate-workflow.guard.test.mjs`: packageRule 20 must **either** still hold
  `<4` **or** name a scanned digest in its description. Both legal; silence is not. Mutation-test it.
- [ ] **T020** [US4] Confirm CI ran a **real sweep**, not a 2-second skip — read the job **duration from the
  commit-status description**, never `stopped - started` from `/actions/runs`.
- [ ] **T021** [US4] Confirm `--check-expiring` reports neither deleted entry as UNMATCHED, and that the
  `infra-image-scan/expiry` status (item #418) shows the step ran on the next scheduled sweep.

---

## Phase 5: The abandon path (only if T004 said abandon)

- [ ] **T022** Leave `allowedVersions: "<4"` in place and all three images on their current pins (FR-011 —
  no half-moved stack).
- [ ] **T023** Re-date both `langfuse/*` entries to **2026-12-01**, with a justification naming the
  **scanned 4.x digests** and what they still bundled. Never a restatement of the existing "`:3` already
  floats to the newest 3.x" reasoning, which says nothing about 4.
- [ ] **T024** Record the measured result in ADR-0002 §3 and the new re-triage date in §6.

---

## Dependencies

- **T004 blocks everything.** Phases 1–4 need "proceed"; Phase 5 needs "abandon".
- T005 → T006 → T007. The Postgres guard is green on the **current** tree before any image moves.
- T007 → T008 → T009 → T010; T011 is `[P]` after T008.
- T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021.

## Out of scope (restated so it is not rediscovered as a task)

- **Postgres 17 / `unleash-postgres`** — FR-005. A separate mandate, not a task here.
- **Moving to `docker.langfuse.com`** — FR-006. Docker Hub publishes the same tags.
- **Preserving trace history** — ADR-0002 §4.
- **The OpenSearch major** — feature 071.
