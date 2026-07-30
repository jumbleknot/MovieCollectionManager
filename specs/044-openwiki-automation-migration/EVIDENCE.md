# Evidence — Feature 044

Committed evidence for FR-034, SC-009, SC-010, SC-016 and SC-017a. The **before** measurement is
recorded first, deliberately: once the relocation runs it cannot be reconstructed from the working
tree, only from git history.

---

## 1. Pre-trim baseline (T003)

Measured on branch `044-openwiki-automation-migration` at commit
`bd64f78c3b14c14dcd4c072d6f04d1cdd57c0ac7`, **before** any relocation task ran.

### `CLAUDE.md`

| Measure | Value |
|---|---|
| Lines | **592** |
| Bytes | **71,983** |
| Words | 9,309 |
| Top-level (`##`) sections | **14** |
| All headings (`#`–`######`) | 40 |
| Machine-managed lines | 24 (`nx configuration`) + 5 (`SPECKIT`) + 9 (`OPENWIKI`) = **38** |

Of the 14 sections, three (`General Guidelines for working with Nx`, `Scaffolding & Generators`,
`When to use nx_docs`) sit **inside** the Nx-managed region and are not the trim's business; the
`OpenWiki` section is inside the generator-managed region. Ten sections are hand-authored content
eligible for relocation.

### Section sizes — where the mass actually is

| Section | Lines | Bytes |
|---|---:|---:|
| `## Testing Requirements` | 214 | **32,784** |
| `## Non-Obvious Design Decisions` | 25 | 8,603 |
| `## Architecture` | 111 | 7,157 |
| `## Configuration` | 17 | 5,437 |
| `## Local Dev Infrastructure` | 41 | 5,333 |
| `## Commands` | 69 | 5,288 |
| `## Logging` | 45 | 2,807 |
| `## Project Overview` | 11 | 749 |
| `## When to use nx_docs` *(Nx-managed)* | 16 | 629 |
| `## OpenWiki` *(generator-managed)* | 8 | 856 |
| `## General Guidelines for working with Nx` *(Nx-managed)* | 8 | 795 |
| `## Spec-Driven Development (SDD)` | 3 | 553 |
| `## Test-Driven Development (TDD)` | 3 | 384 |
| `## Scaffolding & Generators` *(Nx-managed)* | 3 | 157 |

`Testing Requirements` alone is 46% of the file — six paragraph-dense subsections (CI/CD operator
loop, the diagnostics rules, the E2E/DAST/SAST/Trivy scanners, the validation checklist). The line
count understates it badly: 214 lines carry 32.8 KB because most are single very long paragraphs.

### The bundle receiving the content

| Measure | Value |
|---|---|
| Concept pages | **44** |
| Markdown files in total (concepts + `index.md` + `INSTRUCTIONS.md` + `quickstart.md`) | 54 |
| Top-level areas | 7 (`architecture`, `decisions`, `gotchas`, `invariants`, `process`, `projects`, `runbooks`) |

### Sibling assistant surfaces

| File | Lines | Bytes |
|---|---:|---:|
| `AGENTS.md` | 65 | 3,992 |
| `opencode.json` | 8 | 157 |

---

## 2. Retrieval questions for SC-010 — asked before the trim

These eight questions are answerable from `CLAUDE.md` **today**. SC-010 requires each to remain
answerable afterwards from the index plus at most two bundle files; the resolution path for each is
recorded in §4 after the relocation runs.

1. Why does the `mc-service` Docker build need a *vendored* OpenSSL, and why must the dependency be
   musl-conditional rather than unconditional?
2. Which command brings up the local stacks, and why must `auth` come up before the `mcm` app profile?
3. Why does an SSRF host check have to canonicalize an IPv4-mapped IPv6 literal before comparing it
   against the link-local range?
4. What makes a forge merge return `405`, and which endpoint is the authoritative merge signal?
5. Why is MongoDB search implemented with `$regex` rather than `$text`, and why is the text index
   dropped at startup?
6. Which prod host-port range is reserved, and what outage does the reservation exist to prevent?
7. What must never be logged by BFF server-side code, and which logger is mandatory there?
8. Why is `app-e2e` skipping on a pull request *not* evidence that the trigger is path-gated?

---

## 3. Relocation plan review (T049)

### How the scope was determined

Not by reading `CLAUDE.md` and guessing. Each subject in it was searched for in the bundle **and** in
the upstream documentation tree, and only the subjects found in **neither** need relocating — a fact
already present in a runbook satisfies FR-028 where it is, and copying it into a concept would be the
drifting-paraphrase failure `INSTRUCTIONS.md` §1 exists to prevent.

Of the 20 bullets under `## Non-Obvious Design Decisions`, **14 were already covered** by a concept
(cascade delete, collation uniqueness, keyset pagination, the musl/OpenSSL constraint, the SSRF
canonicalized-IP guard, role-enforcement-is-a-layer, HTTP-only cookies, `ownerId` denormalization,
`$regex`-not-`$text`, password-manager suppression, `output: server`, JWKS eager dispatch, and the
`axum-keycloak-auth` OR-logic role check). **Six were not.** A second sweep over the operational
sections found eight more subjects that exist only in `CLAUDE.md`.

### The plan, as produced

```text
[wiki-maintain] plan at c92256fe (since c92256fe)
[wiki-maintain] 0 documentation path(s) changed in range
[wiki-maintain] 3 slice(s), 14 page(s) this run:
  1. gotchas/ (exists) — 8 page(s): rfc-9457-problem-details.md, docker-internal-dns.md,
     external-id-url-opening.md, playwright-testid-mapping.md, session-lifecycle-and-eviction.md,
     keycloak-service-account.md, env-file-inline-comments.md, expo-router-collection-routing.md
  2. invariants/ (exists) — 3 page(s): package-manager-enforcement.md, rtk-token-compression.md,
     feature-validation-checklist.md
  3. process/ (exists) — 3 page(s): pull-request-batching.md, feature-test-scope.md,
     test-authoring-conventions.md
```

**Review against the slice invariants** (FR-002, data-model E1):

| Check | Result |
|---|---|
| No slice exceeds 8 pages | ✅ 8 / 3 / 3 |
| Each slice names exactly one area | ✅ `gotchas`, `invariants`, `process` |
| No slice mixes a new area with an existing one | ✅ all three areas exist; `areaExists: true` throughout |
| Work seeded rather than change-derived | ✅ the marker is at `HEAD`, so `changedPaths` is empty and every slice comes from the backlog — the documented seeding path for a one-off sweep |

The 14 pages exceed neither budget on their own, but the **wall-clock** budget (20 min) is expected to
stop the run between slices — feature 043 measured ~12–17 minutes for a slice of this size. That stop
is exit 3, and the remainder carries forward.

### The twelve concepts that change classification rather than content

Separately from the pages above, twelve existing concepts currently declare `resource: CLAUDE.md`:
six under `gotchas/`, five under `invariants/`, one under `projects/`. Their content is already
relocated — they were generated from those very passages, and each is now richer than the bullet it
came from. What is wrong about them is their **classification**: after the trim, `CLAUDE.md` no longer
holds the content they cite, so the citation would point a reader at a summary of itself.

They therefore become **authoritative** — the `resource` field removed, listed under `authoritative:`
in `protected.yaml`, and declared `event-driven` in `policy.yaml` (G12). That is metadata surgery on a
one-off migration, not a content rewrite, and it is deliberately not given to the generator.

---

## 4. What the relocation actually cost (T050) — the acceptance evidence for US1

FR-027ab makes this run record the acceptance evidence for User Story 1: a real workload of the size
that defeated the generator in feature 043, not a synthetic exercise. Here is what happened.

**Ten runs produced fourteen pages. Roughly half produced nothing at all.**

| Run | Slice | Result |
|---|---|---|
| 1 | 8 new pages | 0 pages — **invalid**: `nx --args` stripped the quoting, so the generator ran UNSCOPED. Killed before it wrote |
| 2 | 8 new pages | 0 pages, 74s — invalid as evidence (sibling processes killed mid-flight) |
| 3 | 8 new pages | 0 pages, 410s — clean. Nx reported success |
| 4 | 8 new pages | 0 pages, 643s — reached *"Now I have enough evidence for all 8 pages"*, then stopped |
| 5 | 1 refresh | 0 pages, 660s — the page needed no change; **the verifier wrongly called this a failure** |
| 6 | 3 new pages | 0 pages, 552s — died mid-research |
| 7 | 3 new pages + subjects | **✅ 3 pages**, 367s |
| 8 | 3 new + 1 refresh | **✅ 4 pages** |
| 9 | 3 new pages | ✗ wrote **one of three** requested |
| 10 | 2 + 3 new pages | **✅ 5 pages** — backlog drained to zero |

**Every failure was reported as a failure**, returned its slice to the committed backlog, and held the
marker. Judged by the generator's exit status — which is what feature 043 did — all ten runs were
successes, and the marker would have advanced over work that never happened.

Run 9 is the sharpest case for the verification contract: it wrote **one of three** requested pages.
The original check ("at least one page appeared") would have called that success and silently dropped
two pages. The contract is now *every requested page exists after the run*, named individually on
failure.

### Five defects found by measurement, not by reasoning

1. **`nx --args` strips the quoting from its value** before splicing it into the shell command, so the
   run message reached the generator as a dozen bare words and it ran **unscoped** — for a tool with
   no `--pages` flag, free to rewrite anything. The message now travels in `WIKI_RUN_MESSAGE`, quoted
   inside the target's own command string. Verified: message intact as one argument, `$(…)` and
   backticks passed through literally, and byte-identical behaviour when the variable is unset.
2. **Nx discards a successful task's output.** 393 seconds of paid work left no trace of why it did
   nothing. `--output-style=stream` now puts the generator's own account in the log — and therefore in
   the CI failure digest.
3. **The run message contradicted the conformance gate.** It said "write ONLY those pages", which
   forbids touching the area `index.md` — while rule V9 *requires* every concept to be listed there.
   The generator resolved the contradiction by writing nothing, at full price. Its own output named
   the omission: *"I did not backlink from … the gotchas index"*.
4. **The verifier had a false negative**, the mirror image of the failure this feature exists to
   catch: a refresh of an already-accurate page legitimately writes nothing, and that was reported as
   broken — which also *halted the run*, since execution stops at the first failed slice. `noChange`
   is now its own honestly-reported outcome.
5. **A filename is not a specification.** The generator spends its budget deducing what each page
   should say; three runs died mid-research. The message now carries a one-line **subject** per page.
   That single change is the difference between 0 pages in 643s and 3 pages in 367s.

### Two numbers that were wrong, and are now measured

- **Slice size for CREATION is 3, not 8.** Feature 043's "8 pages delivered reliably, twice" was
  *refreshing* existing pages, which needs no per-page source investigation. `MAX_PAGES_PER_SLICE = 8`
  stands as FR-002's ceiling for refreshes; `MAX_NEW_PAGES_PER_SLICE = 3` bounds creation, and the two
  kinds are never mixed in one slice so a cheap refresh cannot inherit a creation slice's failure mode.
- **The generator is non-deterministic.** Runs 6 and 7 had the identical slice shape and the identical
  message; one produced nothing and the other produced three verified pages. No amount of message
  engineering makes a single invocation reliable, which is exactly why SC-002 is phrased as *"eventually
  produced across successive runs"*. The backlog is what converts an unreliable generator into a
  completed workload.

**This sharpens the feature's own central finding.** Research R2 held that the page cap is advisory
because the message is an instruction to a model rather than a constraint on a process. Measured, the
truth is stronger: **the message is the entire specification of the work.** An under-specified one
burns a full paid run for nothing, and a self-contradictory one guarantees it.

---

## 5. Post-trim measurement and retrieval verification (T055)

### `CLAUDE.md`, before and after

| Measure | Before | After | Change |
|---|---:|---:|---|
| Lines | 592 | **138** | **−77%** |
| Bytes | 71,983 | **22,244** | **−69%** |
| Words | 9,309 | 2,308 | −75% |
| Machine-managed lines | 38 | 38 | unchanged (FR-032) |
| Hand-authored prose lines | ~520 | **0** | the gate rejects any (G8) |

Of the 138 remaining lines, 38 are the three machine-managed regions and 59 are index entries. There
is no prose left: rule G8 fails the build on any non-blank line outside those regions that is neither
structure nor a link, so the file cannot silently re-grow (FR-040).

### The bundle that received it

| Measure | Before | After |
|---|---:|---:|
| Concepts | 44 | **58** |
| Authoritative concepts (canonical, no upstream source) | 0 | **21** |
| Fingerprinted load-bearing passages | 0 | **21** |
| Areas | 7 | 7 |

### SC-010 — the eight questions, after the trim

Each question from §2 resolves from the index in **one hop** — the index entry names the concept, and
the concept answers it. The budget is two bundle files; every one of the eight came in at one.

| # | Question | Concept | Opens |
|---|---|---|---:|
| 1 | Why a *vendored*, musl-conditional OpenSSL? | `gotchas/mc-service-musl-openssl.md` **[canonical]** | 1 |
| 2 | Stack bring-up order, and why `auth` first? | `runbooks/local-dev.md` | 1 |
| 3 | Why canonicalize an IPv4-mapped IPv6 literal? | `gotchas/agent-config-ssrf-guard.md` **[canonical]** | 1 |
| 4 | What makes a forge merge return 405? | `runbooks/ci-diagnostics.md` | 1 |
| 5 | Why `$regex` rather than `$text`? | `gotchas/mongodb-indexes-and-uniqueness.md` **[canonical]** | 1 |
| 6 | Which prod port range is reserved, and why? | `invariants/published-port-reservation.md` | 1 |
| 7 | What must never be logged by the BFF? | `invariants/logging-and-audit.md` **[canonical]** | 1 |
| 8 | Why is `app-e2e` skipping on a PR not proof of path-gating? | `projects/ci-cd-pipeline.md` **[canonical]** | 1 |

Verified mechanically: for each row, the index contains exactly one entry linking to that path, and
the file exists. G9 fails the build if any index entry stops resolving.

### The human judgement behind SC-010 and SC-016, recorded because no machine can re-check it later

The index is **more** useful than the file it replaced for finding *where* an answer lives, and less
useful for reading straight through. That is the intended trade: 592 lines of prose could only be
searched linearly, whereas 59 entries carrying a title, a canonical/derived marker and a one-line
description can be scanned. The cost is one extra file open per question — measured above as exactly
one, never two.

---

## 6. Destination-rule validation (T054)

SC-017a asks for at least six subjects, spanning runbooks, decision records, the architecture
document, and relocated instruction-file content, where the rule yields exactly one answer with no
judgement call. Seven are recorded; the rule is applied mechanically each time — *find the concept,
look for a `resource`*.

| # | Subject of the learning | Covering concept | Cites a `resource`? | **Destination** |
|---|---|---|---|---|
| 1 | Chromium cannot be installed in the dev container (the Playwright CDN is outside the egress allowlist) | `runbooks/devcontainer.md` | yes → `docs/runbooks/devcontainer.md` | **the runbook**, not the concept |
| 2 | Prod secrets are Komodo Variables, not Vault | `decisions/adr-0001-prod-secrets-management.md` | yes → `docs/decisions/ADR-0001-…md` | **the decision record** |
| 3 | mc-service gained a new port in its application layer | `architecture/system-overview.md` | yes → `docs/MCM-Architecture.md` | **the architecture document** |
| 4 | The forge merge API returns 405 until every required context passes | `runbooks/ci-diagnostics.md` | yes → `docs/runbooks/ci-diagnostics.md` | **the runbook** |
| 5 | `nx --args` strips its quoting, so a scoped run message must travel in the environment | `invariants/nx-task-runner.md` | **no** — canonical | **into the concept** |
| 6 | The musl build needs a vendored OpenSSL, conditionally | `gotchas/mc-service-musl-openssl.md` | **no** — canonical | **into the concept** |
| 7 | A protected passage's fingerprint must be updated in the same change | `process/wiki-maintenance.md` | yes → `infrastructure-as-code/project.json` | **the runbook** `docs/runbooks/wiki-maintenance.md`, which the concept summarizes |

No row required a judgement call: the presence or absence of a `resource` decided every one, and rule
G11 guarantees the field is never ambiguous — a concept that is neither derived nor authoritative, or
both, fails the build.

Row 7 is the one worth noting: the concept cites `project.json`, but a *procedural* learning belongs
in the operator runbook rather than in a JSON file. The rule still resolves — "write it where the
canonical document for this subject is" — but it shows that a citation pointing at configuration
rather than prose makes the destination a short inference instead of a lookup. That is a candidate
refinement for a later feature, not a defect in the rule.

---

## 7. Reversibility (T063, FR-035)

Trial-reverted on a scratch branch and measured, rather than assumed — the safety net is what
justified accepting a full trim over a measured tranche, and an untested safety net is a belief.

**The relocation is two commits**: `8897efa` (the 14 pages) and `6ece8ef` (the manifest, the policy
entries, the index and the surfaces). `git revert --no-commit 6ece8ef 8897efa` restores `CLAUDE.md`
to 592 lines and the bundle to 44 concepts, and:

| Check after the revert | Result |
|---|---|
| `check-openwiki-okf.mjs` (bundle conformance) | **exit 0** |
| A regeneration run needed to restore the prior state | **none** — everything came back from git |

That is FR-035 satisfied: the prior state is recoverable without paying for a single model call.

**One honest caveat.** Reverting only those two commits leaves the governance gate (`c92256f`) in
place, and it then reports 331 violations — because it encodes the *post*-trim invariants and the
content has gone back to its *pre*-trim shape. That is not a defect in the revert; it is the gate
doing its job against a repository that is now inconsistent with it. Reverting the gate as well
(`git revert --no-commit c92256f`) returns everything to a coherent pre-feature state: `okf-lint`
green, 335 script tests passing, gate removed.

So: **the relocation alone is revertible in one operation, and the whole feature in one more.** An
operator reverting the trim in a hurry should revert all three commits.

---

## 8. Proposal gating (T062, FR-014)

The maintenance proposal is an ordinary pull request against `main` from the `openwiki-maintenance`
branch, so it is gated exactly like a hand-authored change: `guardrails.yml` triggers on
`pull_request` with **no path filter**, so its `secret-scan`, `naming`, `okf` (now including the
governance gate), `agent-gates` and `sast` jobs all post statuses on it.

Verified here by construction and by the workflow definitions — the proposal PR itself cannot be
observed until the first real run on `main`, since creating one requires the merge-triggered job to
fire. `node scripts/ci-status.mjs status --pr <n>` is the check to run against it then; the required
context set was confirmed live during T035 and does **not** include `wiki-maintain`, so the paid job
gates nothing.
