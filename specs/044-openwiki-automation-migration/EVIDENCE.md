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

## 4. Post-trim measurement and retrieval verification (T055)

*Pending.*

---

## 5. Destination-rule validation (T054)

*Pending.*
