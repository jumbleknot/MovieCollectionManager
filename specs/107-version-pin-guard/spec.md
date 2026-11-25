# Feature Specification: Version-pin guard — every pin is managed or excused

**Feature Branch**: `107-version-pin-guard`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Backlog item #1128: a guard that every version pin in the repository tree is either managed by Renovate (a built-in or custom manager extracts it) or excluded with a written reason. A pin nobody manages silently ages; MCM has hand-written pins Renovate cannot see (shell-text versions, node-version literals, install-script constants). Adding an unmanaged pin must fail CI naming the file and line; every current pin must be managed or excluded with a reason. Learned from BELAY, which has this guard."

## Context

The repository pins the tools it builds and checks with, on purpose: an unpinned tool is a tool nobody
chose (items #297, #303, #307). A pin is only safe while something keeps it current. Renovate does that
for every pin one of its managers can *see*. It never proposes an update for a pin it cannot see, and
nothing reports that silence. The pin then ages unnoticed until it is the cause of a CVE finding, an
`engines` failure, or a version skew between two places that were meant to agree. Each of those has
already happened here.

The problem is recurring, not one-off. Every time this has been found, it was by a person reading the
right file at the right moment:

- the Renovate version itself, a major pin in shell text (fixed by item #1126);
- Trivy, three copies of a workflow constant (item #303, then #1127);
- uv, rust, semgrep, pip-audit and cargo-audit (items #307, #1114, #1119, #1120).

Each fix added a customManager for that one pin. Nothing stops the *next* hand-written pin from
arriving unmanaged.

A 2026-11-24 inventory found constants with no manager covering them in their files. Examples are
`CCUSAGE_VERSION` in `scripts/lib/cc-usage/write-oracle.mjs`, and `DOCKER_COMPOSE_VERSION`,
`GRADLE_VERSION`, `SPECKIT_VERSION` and `POWERSHELL_VERSION` in `.devcontainer/toolchain.Dockerfile`.
Whether each is genuinely unmanaged is for this feature's inventory to establish, not to assume.

BELAY, a repository bootstrapped from this one, built this guard and found it worth porting back.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A new unmanaged pin cannot merge silently (Priority: P1)

A contributor (human or coding agent) adds a hand-written version to the repository: a
`FOO_VERSION=1.2.3` line in a workflow or install script, a pinned version constant in a script, or a
version in a Dockerfile `ARG`/`ENV`. No Renovate manager extracts it. The pull request fails a required
check. The failure names the file, the line, and the pin, and states the two ways to resolve it: add or
extend a manager, or record an exclusion with a reason.

**Why this priority**: This is the whole point. Every past instance was found by luck, and this makes
the next one a red check on the PR that introduces it, which is when it is cheapest to fix.

**Independent Test**: Add an unmanaged pin to a workflow on a branch and run the check. It fails and
names the file and line. Remove the pin, or add an exclusion with a reason, and it passes.

**Acceptance Scenarios**:

1. **Given** a clean tree that passes the check, **When** a contributor adds `FOO_VERSION=1.2.3` to a workflow `run:` block that no manager covers, **Then** the check fails, naming the file, the line number and `FOO_VERSION`.
2. **Given** the same unmanaged pin, **When** the contributor adds a manager that extracts it, **Then** the check passes with no exclusion needed.
3. **Given** the same unmanaged pin, **When** the contributor records an exclusion with a non-empty reason, **Then** the check passes, and the exclusion is listed in the check's output.

---

### User Story 2 - Every pin in the tree today is accounted for (Priority: P1)

The maintainer can see, for every version pin currently in the repository, either the manager that
keeps it current or the recorded reason it is deliberately left alone. Each pin that has no manager
today either gains one or gets an exclusion with a reason, so the check starts green on an honest
inventory rather than on a blanket allowlist.

**Why this priority**: The guard is only credible if it starts from a real inventory. A guard that
begins by excusing everything it finds tells nobody anything, and that is how an allowlist stops
meaning anything.

**Independent Test**: Run the check on `main` after the feature lands. It passes, and its report
lists each pin as either managed (naming the manager) or excluded (with its reason). There is no
bulk exclusion such as "all of file X" without a per-pin reason.

**Acceptance Scenarios**:

1. **Given** the repository at the start of this feature, **When** the inventory runs, **Then** every detected pin is classified as managed or unmanaged, and the unmanaged list is recorded in the feature's research.
2. **Given** that unmanaged list, **When** the feature is complete, **Then** each item either has a manager or an exclusion whose reason is specific to that pin (for example "pinned by the Expo SDK's toolchain, moves with an SDK upgrade only").

---

### User Story 3 - Exclusions do not rot (Priority: P2)

An exclusion recorded today stays truthful. If the excluded pin is later deleted, or a manager starts
covering it, the stale exclusion is reported, so the exclusion list never grows into a graveyard that
hides real gaps.

**Why this priority**: Exclusions are the guard's escape hatch, and an escape hatch nobody prunes
becomes the hole. Important, but only after the guard exists (P1).

**Independent Test**: Record an exclusion for a pin, then delete the pin. The check fails and names
the exclusion that matches nothing.

**Acceptance Scenarios**:

1. **Given** an exclusion whose pin no longer exists in the tree, **When** the check runs, **Then** it fails, naming the stale exclusion.
2. **Given** an exclusion for a pin that a manager now covers, **When** the check runs, **Then** it fails, saying the exclusion is redundant.

---

### Edge Cases

- **A pin that a manager's file pattern covers but whose match pattern misses.** This counts as **unmanaged**. A manager whose pattern captures nothing is indistinguishable from no manager at all; that is how the nx half-bump (#194) survived review twice.
- **The same tool pinned in several places** (e.g. uv in five files). Each occurrence is a separate pin and must be covered individually. One covered copy does not excuse another.
- **Versions that are not pins:** version strings in comments, changelogs, test fixtures, documentation, specs and lockfiles. These are out of scope and must not be flagged, or the guard drowns in noise and gets loosened.
- **Pins Renovate's built-in managers already handle:** `package.json` dependencies, `FROM` image tags and digests, `uses:` action refs, `Cargo.toml`, `pyproject.toml`. These are managed by construction and should not require per-pin bookkeeping.
- **A pin in a file type the detector does not scan.** It is out of the guard's sight. The scanned file types are stated explicitly, so the boundary is visible rather than implied.
- **The check is run without network access.** It must still give a verdict; see FR-009.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The check MUST detect hand-written version pins in the repository's executable and build surfaces: CI workflow files, shell and Node scripts under `scripts/`, Dockerfiles (including the dev-container toolchain image), and devcontainer configuration. The scanned surfaces MUST be listed in one place.
- **FR-002**: A "pin" MUST include at least these shapes:
  - an assignment of a version-looking value to a name containing `VERSION` or `PIN` (shell, Dockerfile `ARG`/`ENV`, JS constant);
  - a `node-version:`, `version:` or similar version input on a workflow step;
  - a `tool@<version>` specification in a command line.

  Each shape the detector recognises MUST be documented.
- **FR-003**: For each detected pin, the check MUST decide whether a Renovate manager extracts that exact occurrence. It MUST use Renovate's actual configuration: the custom managers in `renovate.json`, and the built-in managers it relies on. Having a manager whose file pattern merely names the file is not enough; the manager's match pattern must capture that occurrence.
- **FR-004**: A pin that no manager extracts and that has no exclusion MUST fail the check. The failure MUST name the file, the line, the pin's name and value, and the two remedies.
- **FR-005**: Exclusions MUST live in one committed file. Each entry MUST identify one pin precisely, by file and pin name, not by a whole-file or wildcard match. Each entry MUST carry a non-empty reason. An entry without a reason MUST fail the check.
- **FR-006**: An exclusion that matches no current pin, or that matches a pin a manager now extracts, MUST fail the check, naming the exclusion.
- **FR-007**: The check MUST run on every pull request as a required check. It MUST be part of the existing required guardrails set, so it gates merges without an operator step.
- **FR-008**: The check MUST print a full classification on success as well as failure: each pin as managed (naming the manager) or excluded (with its reason). This way a green run shows what it checked, not only that it passed.
- **FR-009**: The check MUST be deterministic and offline: no network, and no Renovate run. A verdict that depends on a registry being reachable is a gate that flakes, and a flaky gate gets disabled.
- **FR-010**: The check MUST have its own tests. The tests prove that:
  - an unmanaged pin fails;
  - a pin that a manager's file pattern covers but whose match pattern misses fails;
  - an exclusion without a reason fails;
  - a stale exclusion fails;
  - a version in a comment or fixture is not flagged.

  Each test must turn red when its corresponding rule is removed.
- **FR-011**: The feature MUST resolve every pin that is unmanaged on day one. Each gets a manager, or an exclusion whose reason is specific to it. The resulting inventory is recorded in the feature's research.
- **FR-012**: The renovate runbook MUST document the guard: what it scans, the pin shapes it recognises, how to add a manager, how to add an exclusion and when one is legitimate. Any openwiki page whose source that runbook is MUST be refreshed in the same pull request.

### Key Entities

- **Pin**: one occurrence of a hand-written version in a scanned file, with its file, line, name (where it has one) and value.
- **Manager coverage**: a rule from Renovate's configuration that extracts a pin's value from that file at that location. A pin is "managed" only if some rule captures that occurrence.
- **Exclusion**: a committed record that a specific pin is deliberately not managed. It holds the file, the pin name and the reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a branch that adds one unmanaged pin to a scanned file, the required check fails on the pull request, and its output names that file and line. Verified by a deliberate mutation PR or an equivalent test.
- **SC-002**: On `main` after the feature lands, 100% of detected pins are either managed or excluded with a per-pin reason. Zero wildcard or whole-file exclusions.
- **SC-003**: Every pin found unmanaged by the day-one inventory has a recorded outcome: a manager added, or an exclusion with a reason. The count found and the count resolved are equal and recorded.
- **SC-004**: The check adds no network dependency to the required set, and gives the same verdict on repeated runs of the same commit.
- **SC-005**: A reviewer can tell from a single green run's output which manager keeps each pin current, without opening `renovate.json`.

## Assumptions

- Renovate's built-in managers for manifest files (`package.json`, `Cargo.toml`, `pyproject.toml`), image references (`FROM`, compose `image:`) and action references (`uses:`) are trusted to extract their files. The guard targets the hand-written shapes those managers do not read, and treats those built-in-managed surfaces as managed by construction.
- "Managed" is decided by evaluating `renovate.json`'s own manager patterns offline, not by running Renovate. This is the same approach the existing `renovate-workflow.guard.test.mjs` takes for individual managers. A difference between that evaluation and Renovate's real extraction is a known limit. It is mitigated by the Dependency Dashboard, which lists what Renovate actually extracted.
- `setup-node`'s `node-version` input is a pin in scope. Whether a built-in Renovate manager covers it, or whether it is held to the Node image version by `check-toolchain-consistency.mjs` (which would make it a candidate for a reasoned exclusion), is a question for the feature's research, not decided here.
- Exclusions are expected to be few and specific. A pin that is managed upstream (for example by an SDK) or deliberately frozen (a hold) is a legitimate exclusion; "not worth a manager" is not.
- This is repository CI tooling under `scripts/` and `.forgejo/`, not application code. No application behaviour changes.
