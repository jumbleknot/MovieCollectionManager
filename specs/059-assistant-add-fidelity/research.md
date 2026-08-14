# Phase 0 research — 059 assistant add fidelity

**Date**: 2026-08-14 · **Spec**: [spec.md](./spec.md)

Every finding below was checked against the code or measured in this container. Where it could
**not** be measured here, that is stated as a limit rather than filled in with a plausible answer —
two of this feature's source premises were wrong for exactly that reason.

---

## R1 — Item #163's rename requirement is based on a misreading (CORRECTS the item)

**Decision**: There is no `PG-13` → `PG13` mapping to write. The mapper validates the certification
against the controlled vocabulary `G, PG, PG-13, R, NC-17, NR, Unrated` and passes it through.

**Evidence**:

- `backend/mc-service/src/domain/movie.rs:81-91` — `UsaRating` names its variants `PG13` and `NC17`
  in Rust, but carries `#[serde(rename = "PG-13")]` and `#[serde(rename = "NC-17")]`. The **wire and
  storage** form is the hyphenated one.
- `frontend/mcm-app/src/types/collection.ts:29` — `export type UsaRating = 'G' | 'PG' | 'PG-13' |
  'R' | 'NC-17' | 'NR' | 'Unrated';`
- `agents/movie-assistant/src/nodes/import_resolvers.py:363` — `_VALID_RATINGS = frozenset({"G",
  "PG", "PG-13", "R", "NC-17", "NR", "Unrated"})`, commented "domain/movie.rs UsaRating serde names".
- `mcp-servers/movie-mcp/tests/integration/conftest.py:166` — an existing integration fixture posts
  `"rated": "PG-13"` to mc-service and passes.

**Why it matters**: item #163 AC3 reads the Rust identifiers and asks for the values to be renamed
into them. Implemented literally, the agent would send `PG13`, which is not in the vocabulary
mc-service accepts — the fix would swap one wrong rating for a rejected add. FR-003 now states
validation instead, with the correction recorded inline.

**Alternatives considered**: writing the mapper as specified and adding a second translation back to
hyphenated form at the boundary — rejected as two transformations that cancel out.

---

## R2 — The function both items name does not exist (CORRECTS both items)

**Decision**: The add payload is built by **`to_movie_payload`** (`agents/movie-assistant/src/proposals.py:167`).

**Evidence**: `grep -rn "build_add_movie_payload" --include=*.py agents/` returns nothing.
`proposals.py` defines `to_movie_payload` at line 167; its body spans the lines both items cite
(`"childrens": False` and `"rated": "NR"` are inside it). Its only production caller is
`agents/movie-assistant/src/nodes/approval_gate.py:212`.

The items' line numbers are right and their names are wrong. Recorded so implementation does not
chase a symbol that is not there.

---

## R3 — The certification rides on the existing request; no extra call, no new failure mode

**Decision**: `get_movie_details` requests `/movie/{id}` with `append_to_response=release_dates` and
reads the US entry from the appended block. One request, as clarified in the spec.

**Evidence / current state**: `mcp-servers/web-api-mcp/src/tools.py:96-113` — `get_movie_details`
issues a bare `client.get(f"/movie/{movie_id}")` and returns a candidate with **no rating field at
all** (`source`, `sourceId`, `title`, `year`, `overview`, `genres`, `posterUrl`, `language`). TMDB's
plain movie endpoint carries no certification, which is why item #163's diagnosis — "nothing is read
at all" — is correct even though its remedy needed adjusting (R1).

**Shape — MEASURED live on 2026-08-14** (after R4a made TMDB reachable from the shell). The appended
block nests under the movie object as `release_dates.results`, a list of per-country blocks:

```jsonc
{ "id": 412117, "title": "The Secret Life of Pets 2",
  "release_dates": { "results": [
    { "iso_3166_1": "US", "release_dates": [
        { "certification": "PG", "type": 3, "release_date": "2019-06-07T00:00:00.000Z", "note": "" },
        { "certification": "PG", "type": 5, "release_date": "2019-08-27T00:00:00.000Z", "note": "" } ] } ] } }
```

**The reported film really is PG** — SC-001's expected value is confirmed against the source, not
inferred from the item.

**Real fixtures for every branch, all measured the same day.** The third row is the one that would
have been got wrong by assuming the first entry is the answer:

| TMDB id | Film | US certifications, in published order | Correct result |
|---|---|---|---|
| 412117 | The Secret Life of Pets 2 | `PG`, `PG` | `PG` |
| 603 | The Matrix | `R`, `R`, `""` | `R` |
| 396535 | Train to Busan | `NR`, `NR` | `NR` — the only case where `NR` is truthful (FR-005) |
| 152747 | All Is Lost | `""`, `PG-13`, `PG-13` | `PG-13` — **first entry is empty**; a naive `[0]` read returns `null` and loses a real rating |
| 986280 | Fallen Leaves | seven `""`, then `NR`, `NR` | `NR` — same trap, seven deep |
| 411397 | Agnes | `""` (only) | `null` |
| 1245424 | Nightless Night | *no US block at all* | `null` |

This also re-confirms R1 from the live source: TMDB publishes `PG-13` hyphenated, exactly the form
the product stores. There is nothing to rename.

---

## R4a — TMDB egress from the dev-container SHELL: was blocked, now enabled (RESOLVED, not documented around)

**Decision**: `api.themoviedb.org` is on the dev-container allowlist. The real-TMDB suite runs here
automatically; nothing about this feature is hand-run.

**Why it was blocked, and why that was right until now**: `init-firewall.sh` is default-deny on the
OUTPUT chain and leaves the FORWARD chain alone. Every *runtime* path that calls TMDB — the BFF's
validate-on-save probe, web-api-mcp's curator enrichment — is a **nested container** on FORWARD, so
it was never blocked and an allowlist entry would have done nothing for the app. The runbook's
standing instruction ("do NOT add TMDB to the allowlist") was a guard against widening egress to fix
a *stale-ipset* symptom, whose real fix is re-running the script. It did not cover a **test runner in
the shell**, which is what 059 introduces.

**Measured, 2026-08-14, in this container**:

| Probe | Before | After |
|---|---|---|
| `curl https://api.themoviedb.org/3/` from the shell | exit 28, timeout | `401` — connected, key rejected |
| `curl https://registry.npmjs.org/` (control, same shell) | `200` | `200` |
| `curl https://example.com/` (default-deny control) | timeout | timeout — **default-deny intact** |
| `nx test:integration web-api-mcp` | could not connect | **5 passed, 0 skipped, 0.79 s** |

**Instrument check on that green.** 0.79 s for a suite that makes real TMDB calls is fast enough to
suspect it is not calling anything, so it was checked with a failing control: `get_movie_details`
against the real base returns "The Secret Life of Pets 2" (and confirms `rated` is absent today —
the defect), while the identical code against an unreachable base raises `ConnectTimeout`. The suite
does hit the network.

**Changes made**: `api.themoviedb.org` added to `ALLOWED_DOMAINS` in `.devcontainer/init-firewall.sh`
with the reasoning inline; a `reachable` assertion added to
`.devcontainer/verify/verify-firewall-allowlist.sh` so a rebuild that loses the entry fails there,
naming the allowlist, instead of surfacing as a connect timeout inside pytest; the runbook entry in
`docs/runbooks/devcontainer.md` rewritten to separate the two chains and record the supersession.
The verifier passes, TMDB included, with default-deny still asserted.

---

## R4b — CI does not run this suite either; this feature enrolls it

**Decision**: `web-api-mcp` joins the CI integration step, using the `TMDB_API_KEY` secret that
already exists at job level, with skip-escalation so an absent key or lost egress **fails** rather
than reads green. The certification assertion therefore gates a merge in both environments.

**Evidence**: `.forgejo/workflows/app-ci.yml:572-578` excludes web-api-mcp under 048 FR-013 for two
reasons — runner egress to TMDB unconfirmed, and "which key a CI run should spend has no answer yet".
The second is now answered by inspection: `TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}` is already a
job-level env at line 332 and is already passed into the E2E container at lines 722 and 747. The
first is answered by the first CI run — deliberately, because an unconfirmed egress path that fails
loudly is better than one that stays unexamined.

**Why skip-escalation is not optional here**: the suite's conftest skips cleanly when the key is
absent and has no `MCM_REQUIRE_LIVE_*` guard, so without escalation an unset secret is
indistinguishable from a pass — the precise failure mode the escalation pattern exists to remove.

---

## R4 — Which tier gates what

**Decision**: The mapping's edge cases are pinned by **unit** tests with a stubbed transport (fast,
deterministic, every case including ones no real film exhibits); the **integration** suite proves the
live shape and the named film against real TMDB. Both now block a merge (R4a, R4b).

**Evidence**:

- `.forgejo/workflows/app-ci.yml:572-578` — "web-api-mcp is deliberately NOT enrolled (048 FR-013)…
  its integration tests reach TMDB, and outbound egress from this runner to api.themoviedb.org is
  unconfirmed; and the credential question is unsettled — TMDB keys are per-user in this design."
- `mcp-servers/web-api-mcp/tests/integration/conftest.py:1-8` — "Runs against the REAL TMDB API —
  never a cassette… without it the tests skip rather than fail." No `MCM_REQUIRE_LIVE_*` escalation
  exists for this suite, so an absent key is a silent skip.
- `.forgejo/workflows/app-ci.yml:226` — `nx affected --target=lint,test,typecheck` runs
  `web-api-mcp`'s unit target on every PR; `test:integration` is a separate target and is reached
  only by the enrollment R4b adds.

**Constitutional check**: stubbing the HTTP transport in a **unit** test is explicitly permitted —
"Unit tests test a single function or class in isolation — external dependencies (HTTP clients…)
MAY be mocked" (§Test Type Integrity). The same stub inside `tests/integration/` would be a
violation. The unit tests therefore live under `tests/unit/` and the integration suite stays real.

**Division of labour** — the two tiers are not redundant:

| Case | Unit (stub) | Integration (real TMDB) |
|---|---|---|
| Every branch of the extraction rules, including shapes no real film exhibits | ✅ exhaustive | — |
| The response shape TMDB actually returns | assumes the contract | ✅ the only check |
| SC-001: "The Secret Life of Pets 2" → `PG` | ✅ from a recorded fixture | ✅ from the source |
| Runs offline / in seconds | ✅ | needs egress + key |

A stub-only strategy passes forever against a contract TMDB has changed underneath it; a live-only
strategy cannot cheaply cover an all-empty or missing-block film. Keeping both is the point.

---

## R5 — `rated: null` must be SENT, not omitted

**Decision**: An unset rating is `"rated": null` in the payload — the key stays present.

**Evidence**: `agents/movie-assistant/src/nodes/import_resolvers.py:386-397` — `_CREATE_NULL_DEFAULTS`
exists precisely because "`CreateMovieDto` types them `Option<T>` but only `language` carries
`#[serde(default)]` — the rest must be PRESENT in the JSON or mc-service 422s." `rated` is in that
list. `to_movie_payload` already emits the key unconditionally, so this is satisfied by changing the
value from `"NR"` to `None`, and would be broken by deleting the key.

---

## R6 — The question chain is an explicit stage machine with three places that must agree

**Decision**: Add `awaiting_childrens` as the stage the chain now enters first, and register it in
every set that describes the chain.

**Evidence** — the three places, each of which fails differently if missed:

| Location | Role | Failure if the new stage is missing |
|---|---|---|
| `agents/movie-assistant/src/nodes/organizer.py:471-560` | the transitions themselves | the question is never answered; the flow stalls or falls through |
| `agents/movie-assistant/src/graph.py:166` (`_OWNERSHIP_STAGES`) | routing a bare "yes"/"no" reply back to the organizer | the reply is treated as a new request |
| `agents/movie-assistant/src/nodes/curator.py:122` (local mirror) | suppressing re-enrichment on the answer turn | extraction runs on "yes", finds no film, clears the candidate and resets the member to "what would you like me to look up?" mid-flow |

The curator's own comment states this: "Every stage in the chain needs this, not just the first —
047 added three more, and missing one produces exactly that mid-flow reset on the turn it was
missed." `_MULTI_SELECT_STAGES` (`graph.py:170`) is deliberately **not** touched — the new question
is single-valued (FR-011).

---

## R7 — No frontend change is required for the new question

**Decision**: The children's question reuses the existing `render_selection` Yes/No button pattern.
No frontend file changes.

**Evidence**: `organizer._ask_ownership` (`organizer.py:270-300`) emits an `AIMessage` with a
`RENDER_SELECTION` tool call carrying `[{label: "Yes", value: "yes", kind: "ownership"}, …]`.
`render_selection` (`tools/generative_ui_tools.py:112-122`) coerces any kind outside
`SELECTION_KINDS = {"movie", "collection", "scope", "control"}` to `"control"` — so `"ownership"`
already reaches the client as `"control"`, and the client's zod enum
(`frontend/mcm-app/src/components/agent/selection-options.tsx:106`) stays satisfied without
knowing anything about ownership. A new `kind` value needs no registration for the same reason.

Tapping posts the option's `value` through the normal send path, so a tapped answer and a typed
answer are the same message by construction — FR-012 is satisfied by reusing this control, not by
new code.

---

## R8 — Answer parsing and the re-ask rule already exist

**Decision**: Reuse `_parse_ownership` for the new yes/no, and reuse the established re-ask
behaviour for an unresolvable reply.

**Evidence**: `organizer.py:478-490` — "An unresolvable reply RE-ASKS its own question rather than
guessing or falling through", implemented for `awaiting_ownership` as
`if owned is None: return _ask_ownership(candidate)`. The spec's edge case ("the assistant re-asks…
does not guess") therefore describes existing behaviour to copy, not new behaviour to design.

---

## R9 — The member's answer must survive the approval pause

**Decision**: The children's answer rides on the `ProposalItem` alongside the 047 answers, and is
threaded into `to_movie_payload` at apply time.

**Evidence**: `proposals.py:83-104` — `ProposalItem` carries `owned`, `owned_media`, `ripped`,
`rip_quality` with the comment "Checkpointed with the proposal, so an approval arriving on a later
turn still applies the member's answers." `build_add_proposal` (`proposals.py:297-341`) accepts them
as keyword arguments and `approval_gate.py:212` re-applies them. A children's answer held only in
graph state would be lost across a HITL pause; held on the item, it is checkpointed with everything
else. FR-018a (approval text unchanged) is satisfied because the item's `diff` — the part the member
sees — is not extended.

---

## R10 — Where the E2E coverage lives and what must change

**Decision**: Extend `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts`; all six of its
tests carry `@model-decision` and stay in that tier.

**Evidence**: the file drives the live stack from the dock (`send()` → `render_selection` buttons →
approval → assertion against `/bff-api`), and every `test(...)` in it is tagged `@model-decision`
(lines 70, 155, 215, 261, 303). Five of the six walk a fixed turn sequence that begins at the
ownership question, so inserting a question ahead of it changes all five — this is the update FR-021
requires, not an optional refresh. `agent-add-external-link.spec.ts:78` drives the same add flow and
needs the same treatment.

**Tier consequence, stated plainly**: per the repository's testing-tier invariant, `@model-decision`
does not block a merge. US2's conversational flow is therefore proven only by a non-blocking tier —
unavoidable, because the flow requires the model to choose tools. What is NOT left there is anything
deterministic: the stage transitions, the payload values and the certification mapping are all
unit-tier (R4, and the plan's test strategy below).

---

## Open item deliberately not resolved here

`SC-002` speaks of "a set of films with known, differing US certifications". Which films those are is
a test-data decision for `/speckit-tasks`, not a design decision — the only one fixed by the spec is
"The Secret Life of Pets 2" (2019), named in SC-001 because item #163 requires the reported case to
be asserted.
