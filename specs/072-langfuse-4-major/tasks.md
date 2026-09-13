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
- [X] **T008** [US2] DONE against the real dev stack (option 1): 48 ClickHouse migrations applied cleanly on empty ClickHouse 25.12, all services healthy. MinIO volume deliberately NOT recreated — deviation recorded in research.md. Recreate the `langfuse-postgres`, `langfuse-clickhouse` and MinIO volumes, bring the
  stack up, and confirm every service reaches healthy and Langfuse's migrations complete.
- [X] **T009** [US2] Assert the ten `LANGFUSE_INIT_*` keys re-seeded org / project / user / API keys with
  **no operator UI step** (US-2 #2). The entire cheapness of this migration rests on this being true, so it
  is asserted rather than assumed.
- [X] **T010** [US2] Drive a **real agent turn** and confirm the trace appears in Langfuse 4 — this proves
  the gateway's existing credentials still authenticate against 4.x.
- [X] **T011** [P] [US2] Confirm `postgres` is still **16** and `unleash-postgres` is untouched — T005's
  guard passing, plus Unleash still serving its flags.

---

## Phase 2b: the read path Langfuse 4 removed (US-5) — WIDENED IN after T010

> T010 passed on the write path **and found this**: Langfuse 4 removes `GET /api/public/traces` (404).
> `test_observability_sc008.py` polls it, so SC-008 would stop being checked rather than fail loudly. The
> spec was widened rather than split — the test goes red the moment the images move, so the two cannot land
> separately and a red is never ambiguous.

- [X] **T025** [US5] Write the guard FIRST: no source file may reference `trace.list(` or
  `/api/public/traces`. **Verify RED** against the current tree (the SC-008 test still uses it), which is
  the honest RED — the guard is catching a real defect that exists right now, not a planted one.
- [X] **T026** [US5] Migrate `_fetch_turns` in
  `agents/movie-assistant/tests/integration/test_observability_sc008.py` to
  `client.api.observations.get_many(session_id=…, is_root_observation=True)`, reading `total_cost` and
  `latency` off each observation. Measured available on 4.15.1 against the live stack: the response carries
  `total_cost`, `latency`, `session_id`, `trace_id`, `is_root_observation`, so the mapping is 1:1 with the
  old `tr.total_cost` / `tr.latency`. **T025 must go GREEN.**
- [X] **T027** [US5] Fix `src/observability.py`'s docstring: it says the handler is "the **v3** langchain
  `CallbackHandler`" (FR-014). The dependency is already correct — `langfuse>=2.0,<5` resolves to 4.15.1 —
  so this is stale PROSE, and it is what nearly produced the wrong diagnosis during T010. Do **not** change
  the ingestion path (FR-013).
- [X] **T028** [US5] Run the SC-008 integration test against the live 4.x stack with a priced provider and
  confirm it passes for the same reasons it passed on 3.x: real non-zero cost, real latency, breach path
  still visible (SC-006). **Requires `MCM_ANTHROPIC_API_KEY`** — a skip here proves nothing, so watch the
  SKIP COUNT.

---

> ## ⚠️ PHASE 3 IS AN OPERATOR SEQUENCE, NOT A MERGE
>
> Everything verified in Phase 2 was verified on **fresh** volumes, and Komodo reconciles the EXISTING
> stack — merging alone recreates nothing. **Decided: recreate the prod volumes at cutover.**
>
> The volume work must happen **before** the merge, so it is a planned Langfuse outage. The exact sequence
> and commands are in
> [prod-control-tower.md](../../docs/runbooks/prod-control-tower.md) → *"One-time: cut prod over to
> Langfuse 4 + ClickHouse 25 on RECREATED volumes"*. Do not improvise it here: `docker compose` cannot be
> hand-run on that host, and `down -v` will not remove these volumes because they are `external: true`.

## Phase 3: Production cutover (US-3)

- [X] **T012** [US3] Move the same three images in `compose.prod.yaml` (FR-004).
- [X] **T013** [US3] DONE 2026-09-13 — cut over on recreated volumes. Redeploy `prod-observability` onto **recreated** volumes — follow the runbook sequence verbatim (stop by container name -> `volume rm` -> `volume create` -> merge -> explicit Komodo redeploy). The volumes are `external: true`, so they must be re-created, not just removed. Per ADR-0002 §4 the existing
  production trace history is discarded at this point.
- [ ] **T014** [US3] Verify with an **actual trace from a real turn** (SC-002), not container health — a
  healthy Langfuse that rejects the gateway's credentials is exactly what this stack would otherwise hide.

---

## Phase 4: Rollback drill, then the ceiling and the deletions (US-3, US-4)

- [X] **T015** [US3] DONE 2026-09-13 — performed in DEV (venue residual recorded in research.md). **Perform** the rollback once (FR-010): revert all three prod digests, recreate the
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
