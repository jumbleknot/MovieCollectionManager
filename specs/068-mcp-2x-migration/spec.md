# Feature Specification: MCP SDK 2.x migration on an audited baseline

**Feature Branch**: `068-mcp-2x-migration`

**Created**: 2026-09-08

**Status**: Draft

**Input**: Backlog item #310 — "Migrate mcp 1.x -> 2.x (FastMCP -> MCPServer) across the gateway and all three MCP servers", scoped in session to also close the pip-audit coverage gap that the migration would otherwise land inside.

## Why this exists

Item #310 has three stated triggers for picking the migration up (a security fix only in 2.x; a needed
feature or dependency requiring 2.x; 1.x reaching EOL). **None has fired** — re-measured 2026-09-08:
`mcp 1.30.0` shipped 2026-09-07 and `mcp 1.29.1` carries zero advisories. This is therefore
*scheduled* work taken deliberately, not debt accruing interest, and the spec is written so that a
reviewer can see the migration bought no new exposure rather than having to take it on trust.

The measurement that motivates the two-phase shape: `mcp` 2.x replaces `httpx` with `httpx2` in the
three MCP servers, and **no scanner currently looks at those three projects' dependency graphs** —
`pip-audit` runs against `agents/movie-assistant` alone. Migrating first would put a four-month-old
HTTP client into a blind spot. Auditing first makes any later advisory attributable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every Python dependency graph is scanned (Priority: P1)

A maintainer opens a pull request that changes any Python lockfile in the repository. The security
gate reports advisories for all four Python projects — the agent gateway *and* the three MCP servers —
and a suppression accepted for one project does not silently apply to the others.

**Why this priority**: It is the precondition for reading Phase 2's result honestly. It also stands
entirely on its own: it is valuable whether or not the SDK migration ever happens, and it ships while
`mcp` is still 1.x, establishing the green baseline the migration is measured against.

**Independent Test**: Land Phase 1 alone with `mcp` unchanged at 1.29.1. The `sast` gate passes, and
its report shows four `pip-audit` surfaces with package counts summing to roughly 185 + 3×55.

**Acceptance Scenarios**:

1. **Given** the four Python projects at their current locked versions, **When** the security scan
   runs, **Then** the report contains findings sourced from all four projects, and each project's
   runtime-versus-development classification is derived from that project's own dependency graph
   rather than borrowed from the gateway's.
2. **Given** an advisory affecting a package present in two projects, **When** the scan runs,
   **Then** the two findings are distinguishable by project.
3. **Given** a suppression entry written for one project, **When** the scan runs, **Then** it
   suppresses that project's finding only, and a second project's finding for the same advisory
   still blocks.
4. **Given** a suppression entry for the Python scanner whose target pattern names no surface the
   scan covers, **When** the gate runs, **Then** it fails, naming the entry — a suppression that
   *can never* match is a defect, and unlike a suppression that merely *did not* match this run, it
   is detectable without waiting for the scan to produce a finding.
5. **Given** the security scan completes, **When** a maintainer reads the runbook's scanner table,
   **Then** the documented surface for the Python scanner matches what actually ran.
6. **Given** a Python project directory exists in the repository but is absent from the set of
   surfaces the scan covers, **When** the scan runs, **Then** it **fails**, naming that directory —
   a project the scanner does not know about is never silently omitted.

---

### User Story 2 - The three MCP tool servers run on the 2.x SDK (Priority: P2)

The three MCP servers start, serve their tools over streamable HTTP, and remain reachable from the
agent gateway by their Docker service names, with the same DNS-rebinding posture they have today.

**Why this priority**: It is the larger half of the migration by file count, and it is where the
newly-audited dependency change lands. It depends on Story 1 only for interpretability, not
mechanically.

**Independent Test**: Each server's own unit and integration suites pass, and the containerized
servers answer a tool call addressed to their service-name host.

**Acceptance Scenarios**:

1. **Given** a server built on the 2.x SDK, **When** it is addressed by its Docker service name
   (for example `movie-mcp:8000`), **Then** the request is served rather than rejected as a host
   mismatch — the protection that today's code deliberately disables stays disabled, having moved
   to a different configuration point.
2. **Given** a tool that returns a mapping, **When** it is called, **Then** the caller receives the
   mapping as structured data; **and given** a tool that returns a sequence, **Then** the caller
   receives it wrapped under a single `result` key — both matching present behaviour exactly.
3. **Given** a tool declared without a precise return type, **When** the guard runs, **Then** it
   fails — because an imprecise return type silently yields no structured content on 2.x, which
   would change what the assistant sees without any test noticing.
4. **Given** a tool that fails against its upstream service, **When** it is called, **Then** the
   error still surfaces as a tool error carrying the upstream status, not as a transport failure.

---

### User Story 3 - The gateway calls MCP tools on the 2.x SDK with token custody intact (Priority: P2)

The agent gateway lists and calls tools on the three servers, forwarding the per-call downscoped
token and the per-run external API key exactly as it does today, and never persisting either.

**Why this priority**: Same phase as Story 2 and lands with it, but called out separately because it
is the only part of this work that rewrites credential-carrying code, and so carries a different
class of risk. The constitution's Identity Propagation rule is non-negotiable here.

**Independent Test**: The gateway's integration tests that exercise a live `movie-mcp` and
`web-api-mcp` pass, including the cases asserting a call carries no bearer where it should not.

**Acceptance Scenarios**:

1. **Given** a tool call to the movie server with a downscoped token set for the call, **When** the
   request reaches the server, **Then** it carries that token as a bearer credential.
2. **Given** a tool call to the external-API server with no downscoped token but a per-run API key,
   **When** the request reaches the server, **Then** it carries the API key and **no** bearer
   credential — the two credentials remain independent, each omitted when unset.
3. **Given** a completed or failed tool call, **When** the call returns, **Then** any client
   resources it opened are released, and no credential appears in checkpointed state, traces or
   logs.
4. **Given** a tool call that errors, **When** the result is converted for the assistant, **Then**
   the error flag, structured payload and text are populated as they are today.

---

### Edge Cases

- **A suppression entry is migrated but stops matching.** The repository has already been bitten by
  an allowlist entry that quietly matched nothing after an identifier-namespace change. Phase 1 must
  fail loudly on a non-matching entry rather than pass.
- **A tool return type is loosened later.** Nothing today would catch an imprecise return
  annotation; on 2.x it silently drops structured content. Story 2 scenario 3 exists for this.
- **A 2.x server is reached by a 1.x client, or vice versa, during a partial rollout.** Measured
  during planning: all four client/server version combinations interoperate, so Stories 2 and 3 need
  not land atomically (see plan research R4). Re-measure if the SDK version moves off the one
  planned against.
- **The security scan's advisory source is unreachable.** The scan already fails closed when
  advisory data cannot be fetched; extending it to four surfaces must not turn a fetch failure into
  a silent partial scan of three.
- **A future project is added under the MCP server directory.** The scan must fail, naming it,
  rather than skip it silently — see FR-021 and US1 scenario 6. This is the feature's own thesis
  turned on itself: a static list of four surfaces has no opinion about a fifth.

## Requirements *(mandatory)*

### Functional Requirements

#### Phase 1 — audit coverage (ships first, as its own pull request)

- **FR-001**: The Python dependency scan MUST cover all four Python projects — the agent gateway and
  the three MCP servers — not the gateway alone.
- **FR-002**: Each project's runtime-versus-development scope classification MUST be derived from
  that project's own dependency graph.
- **FR-003**: Every Python advisory finding MUST identify the project it came from, in a form the
  suppression mechanism can target.
- **FR-004**: A suppression entry MUST apply only to the project it names.
- **FR-005**: Every Python-scanner suppression entry MUST be checked **statically** against the set
  of surfaces the scan covers: its target pattern MUST either anchor to one known surface, or carry
  an explicit declaration that it deliberately spans surfaces. An entry naming an unknown surface
  MUST fail the gate, naming the entry.
  - This is the merge-gate half, and it is deliberately **finding-independent**. Runtime detection of
    an entry that matched nothing *this run* already exists elsewhere in the repository, but it is
    report-only, runs on a separate schedule, and is suppressed when its scanner produced no
    findings — which is the Python scanner's normal healthy state here. A check that only fires when
    something is already wrong cannot catch a malformed entry.
- **FR-006**: The existing suppression for the click advisory MUST be removed rather than migrated —
  the package now resolves to a version the advisory does not affect, in all four projects, so the
  entry suppresses nothing.
- **FR-007**: The security gate MUST prepare each project's environment before scanning it, by the
  same mechanism used for the gateway today.
- **FR-008**: The scan MUST fail rather than silently omit a project whose environment is missing or
  whose advisory lookup fails.
- **FR-009**: The scanning runbook's documented surface for the Python scanner, and the suppression
  file's comment asserting the MCP servers are deliberately unscanned, MUST be corrected to match
  reality.
- **FR-021**: The set of Python surfaces the scan covers MUST be validated against the Python
  project directories actually present in the repository. A project present on disk but absent from
  that set MUST fail the scan, naming it. Neither silent omission nor silent auto-inclusion is
  acceptable: omission rebuilds the blind spot this feature exists to close, and auto-inclusion puts
  an unreviewed dependency graph into a merge gate without anyone deciding to.

#### Phase 2 — SDK migration (ships second, after Phase 1 is green on `main`)

- **FR-010**: All four Python projects MUST declare and resolve the MCP SDK at major version 2,
  bounded below 3, consistent with the repository's one-major-per-bound policy.
- **FR-011**: The three MCP servers MUST construct their server object through the 2.x entry point.
- **FR-012**: The three MCP servers MUST preserve their current transport configuration — stateless
  operation, JSON responses, and disabled DNS-rebinding host validation — at whichever configuration
  point 2.x exposes it.
- **FR-013**: The host-binding behaviour of the servers' HTTP application MUST be stated explicitly
  rather than left to a default, because 2.x introduces a host parameter that interacts with the
  host-validation behaviour being disabled.
- **FR-014**: The gateway MUST forward the per-call downscoped token and the per-run external API key
  to MCP servers as request headers, each omitted when unset, exactly as today.
- **FR-015**: Any HTTP client the gateway creates for an MCP call MUST be released when the call
  completes, on both the success and failure paths.
- **FR-016**: Every consumer of MCP result and tool-descriptor fields MUST be updated to the 2.x
  field names; none may be left reading a name that no longer exists.
- **FR-017**: The two server integration suites MUST use a publicly supported in-process client
  rather than a private module of the SDK.
- **FR-018**: Every MCP tool MUST declare a precise return type, enforced by a test, so that
  structured output cannot be silently lost.
- **FR-019**: Tool result semantics — structured payload for mappings, `result`-wrapped for
  sequences, error flag, text content — MUST be unchanged from 1.x behaviour, asserted by test.
- **FR-020**: No credential may be written to checkpointed agent state, traces, or logs by the
  rewritten transport code.

### Key Entities

- **Python project surface**: one of the four directories with its own dependency lockfile; the unit
  the security scan iterates over and the unit a suppression targets.
- **Advisory finding**: a vulnerability reported against a package version within a project surface;
  carries severity, runtime-or-development scope, and whether it blocks a merge.
- **Suppression entry**: an accepted-or-not-exploitable determination targeting a finding, with a
  justification, an owner and an expiry.
- **MCP tool result**: the structured payload, text content and error flag a tool call returns to the
  assistant — the contract that must not shift under the migration.
- **Per-call credential**: the downscoped backend token and the per-run external API key, each set
  immediately before a call and read by the transport layer, never persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The number of Python projects whose dependency graphs are scanned by the merge gate
  rises from 1 to 4.
- **SC-002**: Phase 1 lands with the merge gate green and zero advisories reported across the three
  newly covered projects — the measured baseline as of 2026-09-08.
- **SC-003**: Phase 2 introduces zero new advisories relative to that Phase 1 baseline.
- **SC-004**: A suppression accepted for one project demonstrably fails to suppress the same
  advisory in another, shown by a test.
- **SC-005**: Zero source references to removed SDK names remain after Phase 2, verified by search
  as well as by the suites passing.
- **SC-006**: The assistant's observable behaviour is unchanged across the migration: the golden
  tier and the merge-gating end-to-end tier pass at the same pass rate as on `main`.
- **SC-007**: Both phases land as two pull requests, so a failing security gate on the second is
  unambiguously attributable to the migration.
- **SC-008**: Adding a new Python project directory without registering it as a scanned surface
  fails the security gate, demonstrated by test rather than asserted.

## Assumptions

- **Neither of item #310's remaining triggers is expected to fire during this work.** If a
  2.x-only security fix lands mid-flight, Phase 2's priority rises but its content does not change.
- ~~**The MCP wire protocol is unchanged between 1.x and 2.x.**~~ **Resolved during planning by
  measurement** (research R4), not left as an assumption: both cross-version directions and both
  same-version controls pass. Stories 2 and 3 may be separate commits.
- **The measured dependency resolution holds**: the SDK resolves to 2.2.0, the servers gain the
  `httpx2` client stack and lose the `httpx` stack plus two settings packages, and the gateway gains
  only the wire-types package. Re-resolution at implementation time may differ if upstream publishes
  again; the plan re-runs the comparison rather than trusting this spec's numbers.
- **The new HTTP client stack is not new exposure.** It is already present in the gateway's lockfile
  today via two unrelated dependencies, so the merge gate has been scanning it all along. What
  changes is that it enters three projects that nothing was scanning — which Phase 1 fixes first.
- **Test tier classification is unchanged.** The migration rewrites how existing tests construct
  their client; it does not move a test between tiers or substitute a dependency that is real today.
- **The suppression file has exactly one Python entry to reconcile.** If another is added before
  this work lands, it is migrated to the project-qualified form rather than removed.
