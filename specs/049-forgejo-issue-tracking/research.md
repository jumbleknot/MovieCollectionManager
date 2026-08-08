# Phase 0 — Research: Forgejo issue tracking

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-08-08

Everything below marked **measured** was observed against the live forge from inside the dev container
on 2026-08-08. **All probes were read-only.** No item was created, edited, commented on, closed or
linked — writing to the operator's tracker is an operator-visible act and belongs to implementation,
not to planning. Consequently the write path is explicitly *unverified* here, and saying so is the
point: FR-006 exists because this project has already paid for one silently-degraded credential.

Forge build, measured: **`15.0.3+gitea-1.22.0`** (`GET /api/v1/version` → 200). This matches the build
the PRD's 2026-07-18 probes ran against, so those measurements remain applicable.

---

## D1. API base and repository slug — derive from the git remote, not from `FORGE_REGISTRY_HOST`

**Decision**: Derive `{base, owner, repo}` from `git remote get-url origin` with the same regex
`ci-status.mjs` uses, and use `FORGE_REGISTRY_HOST` for nothing in this feature.

**Rationale (measured)**: The PRD (§3.2) specifies the API base come from `FORGE_REGISTRY_HOST`
"already in `containerEnv` for the firewall". That value is a **bare hostname with no port**; the
forge's HTTP API is served on a non-default port that only the remote URL carries. The first probe pass
built `http://$FORGE_REGISTRY_HOST/api/v1` and every single call failed with `TypeError: fetch failed`
— which reads exactly like an unreachable forge or a blocked firewall, and would have been diagnosed as
one. Deriving scheme+host+port from the remote fixed all 14 calls in the same run.

This is the single most expensive trap Phase 0 removed: an environment-variable-derived base is
*plausible*, produces a *credible* failure mode, and is wrong.

**Alternatives considered**:
- `FORGE_REGISTRY_HOST` + a hardcoded port — reintroduces a topology literal and would have to be
  scrubbed; also wrong the moment the forge moves.
- A new `MCM_FORGE_API_BASE` env var — a third thing to set on the host and to forget to set, for
  information the working copy already carries unambiguously.
- Reusing the exported helper from `ci-status.mjs` — it is module-private (`forgeEndpoint()`), so this
  feature either exports it from there or duplicates ~4 lines. **Decision**: export it from
  `ci-status.mjs` and import it, so there is one derivation and one place for the port trap to be fixed.

---

## D2. Listing: `type=issues`, page size, and the authoritative total

**Decision**: Always send `type=issues`; always send `page` and `limit` together; take totals from the
`x-total-count` response header; treat 50 as the hard page ceiling and page until the total is reached
or an explicit truncation notice is printed.

**Measured** (issues endpoint, and — where row counts matter — on `type=pulls`, which has 142 rows to
page through, because the tracker itself has only one item):

| Query | Result |
| --- | --- |
| `?type=issues&state=all&page=1&limit=5` | 200, 1 row, `x-total-count: 1` |
| `?state=all&page=1&limit=5` (no `type`) | 200, 5 rows, **`x-total-count: 143`** — pull requests interleaved |
| `?type=pulls&state=all&page=1&limit=3` | 200, 3 rows, total 142 |
| `?type=pulls&state=all&limit=3` (**no `page`**) | 200, **3 rows** — page size honoured |
| `?type=pulls&state=all` (neither) | 200, **30 rows** — default page size |
| `?type=pulls&state=all&limit=60&page=1` | 200, **50 rows** — capped |
| `?type=pulls&state=all&limit=200&page=1` | 200, **50 rows** — capped |
| `?type=pulls&state=all&page=2&limit=3` | 200, 3 rows, correct second page |
| `x-total-count` on single-item `GET /issues/{n}` | **absent** — header is list-endpoints only |
| `link` header | present on every list response |

**Rationale**: Two of the PRD's stated quirks needed correcting:

1. **`limit` without `page` is NOT silently ignored** on the issues endpoint. The PRD carried that
   forward from an `actions/runs` measurement and flagged it as needing verification — correctly, and it
   does not transfer. FR-007's paired-parameter rule is kept, but as *explicitness*, not as a
   workaround: the real hazard is the **cap of 50**, which silently truncates a request for 200.
2. **`type=issues` is genuinely load-bearing** and now has a number attached: omitting it inflates the
   result set from 1 to 143 because pull requests are issues internally (Gitea heritage). A backlog
   listing without it is 99% pull requests on this repo.

**Alternatives considered**: Following the `link` header instead of counting against `x-total-count` —
works, but `x-total-count` gives a total *before* paging, which is what an explicit truncation notice
needs (FR-008). Both are available; the header total is the primary and `link` is a cross-check.

---

## D3. `labels=` with an unknown name silently returns the UNFILTERED set

**Decision**: Resolve every label name against `GET /labels` before using it in a filter or applying it
to an item, and fail loudly (naming the unknown label and listing the valid ones) instead of sending it
to the API.

**Measured**: the repository currently defines **zero** labels (`GET /labels` → 200, `x-total-count: 0`)
and the single existing item carries none. Yet:

| Query | Expected if the filter worked | Measured |
| --- | --- | --- |
| `?type=issues&state=all&labels=type/bug` | 0 rows | **1 row, total 1** — the unfiltered set |
| `?type=issues&state=all&labels=no-such-label` | 0 rows | **1 row, total 1** — the unfiltered set |
| `?type=issues&state=all&q=zzz-nonexistent` | 0 rows | 0 rows, total 0 — `q` **is** honoured |

**Rationale**: This is the highest-value finding of Phase 0 and it is exactly the class of defect this
repository's gates exist to catch: *a filter that fails open looks like a filter that matched
everything*. An agent asking "show me the P1 bugs", typo'ing a label, and getting the whole backlog back
would proceed with confident, wrong output. `q` failing closed while `labels` fails open makes the
inconsistency easy to trust wrongly.

Client-side re-filtering after the fetch is **not** sufficient on its own (it would silently mask the
operator's typo), so the tool validates the name first and refuses.

**Follow-up (implementation, FR-017)**: once the taxonomy labels exist, re-run this probe with a *real*
label to record the positive behaviour — whether `labels=` matches by name, is comma-separated, and is
AND or OR across multiple values. Only the unknown-name behaviour is established today.

---

## D4. The tracker is not empty — Renovate owns issue #29

**Decision**: Setup applies a `status/bot-managed` label to #29, the ready-work query excludes that
label, and the skill states that bot-managed items are never edited, closed, or swept.

**Measured**: `GET /issues?type=issues&state=all` → one item:

- **#29 "Dependency Dashboard"**, open, authored 2026-07-06, no labels, no milestone, 0 comments, body
  beginning *"This issue lists Renovate updates and detected dependencies…"* — i.e. Renovate's dashboard
  issue, which the bot rewrites on its own schedule.
- Issue and pull-request numbers share **one sequence**: pull requests currently occupy #100–#143 while
  the only issue is #29.

**Rationale**: The PRD's premise ("holds zero issues") is false, and the difference matters in two ways.
First, any "close everything stale" or bulk-relabel sweep would hit a bot-owned issue whose content is
regenerated — a confusing, self-reverting mess, and precisely the unauditable-by-diff risk the spec
names. Second, the shared number sequence means a bare `#N` in prose or a commit message is ambiguous
between a backlog item and a pull request; the skill should write `item #N` when it means a backlog item.

**Alternatives considered**: Excluding by author login — rejected: the dashboard's author is the
operator's own account (`jumbleknot`), not a distinguishable bot user, so author-based exclusion would
also exclude every operator-filed item. Excluding by title match — rejected as brittle. An explicit
label is deterministic, visible in the web UI, and operator-overridable.

---

## D5. Credential model — account-wide reach is the operator's decision; scope is the bound

**Decision**: Use the existing `MCM_FORGE_ISSUE_TOKEN` as-is. Its reach is not restricted to this
repository, deliberately. **Permission scope** (repository-read + item-write) is the server-side bound,
and the tooling's **same-repository guard** is the client-side bound — which is why that guard was
widened from the task fan-out to every write path (FR-016).

**Operator decision, 2026-08-08**: the token was intentionally not scoped to this repository, and it
carries repository-read plus item-write only. This supersedes the source PRD §3.1 requirement for a
dedicated single-repository bot account, and supersedes the earlier reading of this section below, which
treated the credential as non-compliant and made re-minting a blocking prerequisite. No re-mint is
required and no setup step is blocked.

What the measurements below still buy, given that decision:

- They confirm the credential is **present and functional for reads today**, so the read path can be
  built and verified before any write is attempted.
- They establish that `permissions.admin` in the repository payload reflects the **account's repository
  access, not the token's scopes** — so it must not be used as a scope check. A `write:issue`-only token
  on an admin account reports `admin:true` and still cannot push code. Any diagnostic that inferred
  "over-privileged token" from that field would be wrong; the tool therefore reports scopes by
  *observing refusals* (D6), never by reading this field.
- They establish that the owning account **cannot be read back through the API** (`/user` → 403, no
  `read:user` on either token), so a `whoami`-style command cannot exist without widening scope. This is
  why the design does not attempt one.

**Measured**:

| Probe | Read token (`MCM_FORGE_TOKEN`) | Write token (`MCM_FORGE_ISSUE_TOKEN`) |
| --- | --- | --- |
| Present in container | yes | **yes — already set** |
| `GET /repos/<owner>/mcm` | 200 | 200 |
| …reported `permissions` | `{admin:true, push:true, pull:true}` | **`{admin:true, push:true, pull:true}`** |
| `GET /issues?type=issues` | 200 | 200 |
| `GET /user` | **403** | **403** |
| `GET /user/repos` | not probed | **403** |
| Any write | not attempted (deliberate) | **not attempted (deliberate)** |

The `permissions` row is the one that most invites a wrong conclusion, so it is worth stating flatly:
**it is not a scope check.** It reports what the owning *account* may do with the repository, and a
token restricted to item-write on an admin account reports `admin:true` while still being unable to push
a commit. The scopes themselves are not exposed by any endpoint this credential can reach.

**Alternatives considered**:
- Widening `MCM_FORGE_TOKEN` instead of keeping a second credential — still rejected: its read-only
  scope set is load-bearing for CI diagnostics, and merging them would give both features one credential
  and one revocation. Two tokens, two revocations, unchanged.
- Adding `read:user` so the tool could self-report which account it is acting as — rejected as scope
  creep on a credential whose justification is minimal permission. It would also be the only scope added
  for diagnostics rather than for function.
- Restricting the credential to this repository — **the operator's explicit decision is not to**, and
  that decision is respected. The design compensates on the client side (FR-016) rather than arguing
  with it.

---

## D6. Read-token fallback and how a scope failure is reported

**Decision**: Reads use `MCM_FORGE_ISSUE_TOKEN` when set and fall back to `MCM_FORGE_TOKEN`; writes
require `MCM_FORGE_ISSUE_TOKEN` and throw a named error when it is absent. A 401/403 is turned into a
message naming *which* token was used and *which* scope is missing, modelled on
`describeAuthFailure()` in `ci-status.mjs`.

**Rationale (measured)**: The write token already reads the repository and the issue list successfully
(200/200), so the fallback ordering is safe: when it is present, reads need no second credential. The
403s observed on `/user` are the exact shape the diagnosis path must handle — a granular scope refusal
from a token that returns 200 on other endpoints in the same second. `ci-status.mjs` already words this
correctly ("This is granular scope, not expiry"), and that wording is reused rather than reinvented.

**Alternatives considered**: Always reading with the read-only token — rejected: it would mean the
feature keeps working when the write token is broken in a way that hides the breakage until the first
write, which is the FR-006 failure mode.

---

## D7. Dependencies, and how the ready-work query is computed

**Decision**: `ready` = open items, minus `status/bot-managed`, minus items with unresolved blockers,
ordered by priority label. The `status/blocked` label is the cheap pre-filter; the
`GET /issues/{n}/dependencies` result is the **authority**, and a disagreement between the two is
printed as a warning rather than silently resolved.

**Measured**: dependency support is enabled on this repository —
`internal_tracker.enable_issue_dependencies: true` — and both endpoints answer 200 today:
`GET /issues/{n}/dependencies` → `array(0)` (blockers of the item) and `GET /issues/{n}/blocks` →
`array(0)` (items it blocks). Neither returns `x-total-count`, so they are read as whole small arrays.
`GET /issues/{n}/timeline` also exists (200, `x-total-count` present) if provenance is ever needed.

**Rationale**: The dependency endpoints are the only machine-readable ordering the forge offers in this
build (Projects boards have no API — D9), so they must be the authority. But one dependency call per
candidate is an N+1: with the concurrency capped at 4 and a backlog in the tens, that is well inside the
performance goal, and the `status/blocked` pre-filter keeps the common case to a single call. Printing
the label/graph disagreement rather than hiding it is what stops the label from quietly becoming a lie.

**Alternatives considered**: Trusting `status/blocked` alone — rejected: a human-maintained label
drifting from the graph is the "silently forked state" failure the spec calls out for boards. Fetching
dependencies for *every* open item unconditionally — rejected as needless traffic once the label agrees.

---

## D8. The issue form — path, format, and how it gets verified

**Decision**: A YAML issue form at `.forgejo/issue_template/backlog-item.yaml`, verified after commit
via the forge's own `GET /repos/{owner}/{repo}/issue_config/validate`.

**Measured**: `GET …/issue_config` → 200 `{blank_issues_enabled, contact_links}` and
`GET …/issue_config/validate` → 200 `{valid, message}`. `GET …/issue_templates` currently returns
`null` — no template is configured today, consistent with the tracker never having been used.

**Rationale — CORRECTED 2026-08-08, after the branch was pushed:** this section originally claimed that
`issue_config/validate` "turns *did the form parse?* into a checkable assertion". **It does not.** Measured
with the form present on a pushed feature branch and no template in effect:

| Probe | Result |
| --- | --- |
| `GET contents/.forgejo/issue_template/backlog-item.yaml?ref=<branch>` | **200** — the forge can see the file |
| `GET issue_templates` | **null** — no template enumerated |
| `GET issue_config/validate` | **`{"valid":true,"message":""}`** — reports valid with **zero** templates |

So `valid:true` is not evidence of a working form: that endpoint validates the issue *config*
(blank-issues, contact links), not the YAML. Treating it as the acceptance check would have reported a
healthy form on a repository that has none — the same fail-open shape as D3's label filter, and it would
have passed FR-013 vacuously. The real assertion is that **`issue_templates` enumerates the form**, which
is what `validate-form` now reports (with the field ids, so a silently-dropped section is visible too).

The same run **proved** the default-branch constraint rather than assuming it: the file demonstrably
existed on a ref the forge could read, and `issue_templates` was still empty. Before the push, the
observation was equally consistent with "the file was never pushed anywhere" — an ambiguity this feature
carried for two days and only noticed when T050's "needs a rebuild" was challenged.

**Alternatives considered**: `.gitea/issue_template/` or `.github/ISSUE_TEMPLATE/` — both are read by
this build for compatibility, but `.forgejo/` is the native path for a Forgejo-hosted repository and
matches the existing `.forgejo/workflows/` convention in this repo. A markdown template instead of a
YAML form — rejected: only the YAML form guarantees the *same sections* on every item, which is what
SC-011 measures.

---

## D9. Open questions from the PRD — all five resolved

| PRD question | Resolution | Basis |
| --- | --- | --- |
| **OQ-1 — bot permission granularity** | **Moot by operator decision** (2026-08-08): the credential is deliberately not repository-restricted, so there is no grant to make granular. Permission scope (repository-read + item-write) bounds it server-side; the same-repository write guard bounds it client-side. Worth recording anyway: the repository is user-owned, so an issues-unit-only team grant was not available even had it been wanted. | Operator decision + measured repo payload (D5) |
| **OQ-2 — final label taxonomy** | Ship the starting set in [data-model.md](data-model.md) unchanged, plus one addition the measurements forced: `status/bot-managed` (D4). Calibrate against the real backlog during the acceptance exercise. The repository currently has **zero** labels, so setup creates all of them — nothing to reconcile. | Measured: `GET /labels` → 0 |
| **OQ-3 — `tea` CLI for operator convenience** | **Rejected / out of scope.** No functional requirement needs it, and adding a Go binary to the toolchain image would pull a new supply-chain surface through the CVE gate for human convenience the web UI already provides. Not blocked from being added later. | Decision |
| **OQ-4 — Nx target for the script** | **No target**, per the `ci-status.mjs` precedent; recorded as a deviation with justification in the plan's Complexity Tracking. Its unit tests still run inside the CI gate. | Decision + precedent |
| **OQ-5 — `closes #N` merge-time auto-closure** | **Not adopted** (already recorded in the spec's Assumptions). D4 adds a second, independent reason: issues and pull requests share one number sequence, so a mistyped `closes #N` in a commit message can silently close an unrelated item at merge time. | Decision + measured |

---

## D10. Why a skill and not an MCP server (restated, with the local numbers)

**Decision**: Unchanged from the PRD — a thin skill plus a script, no MCP server.

**Rationale**: An MCP server's tool schemas load into *every* session whether the backlog is touched or
not; the skill's ≈1–2k tokens load only when invoked (SC-009). The same economics justify RTK, which the
constitution already mandates for exactly this reason. Two further local factors: the guidance must also
serve the other assistants that read this repository's documentation, where an MCP registration is
per-tool configuration; and the measured quirks (D3 especially) belong in prose an agent *reads before
deciding*, not buried in a tool description it never sees. An MCP server remains a compatible later
addition — nothing in this design blocks it.

---

## Open risks carried into implementation

1. **The write path is unverified.** Create/edit/close/comment/dependency calls were deliberately not
   attempted. The first write is also the first proof, and it must be run as the explicit sequence in
   [quickstart.md](quickstart.md) — including the negative half: the same calls must return **403 under
   `MCM_FORGE_TOKEN`**, or the scope split is not real.
2. **The blocked-close error shape is unknown.** That closing a blocked item is refused is documented
   behaviour of this tracker family, but the *status code and message* were not observed (it needs two
   items and a dependency link). FR-010's distinct surfacing must be written against the observed
   response, not a guess — so the classifier lands after that probe, and the test uses the captured
   response as its fixture.
3. **`labels=` positive behaviour is unmeasured** (D3 follow-up): matching semantics for a real label,
   and AND-vs-OR across multiple values.
4. **The credential's scopes cannot be self-checked** (D5). The operator states them as repository-read
   plus item-write, and no endpoint this token can reach reports its own scopes — `permissions` in the
   repository payload answers a different question. So the scope split is proven the only way available:
   by the write sequence succeeding under `MCM_FORGE_ISSUE_TOKEN` and the same calls returning **403**
   under `MCM_FORGE_TOKEN` (risk 1). A pass there is the evidence; anything else is assertion.
