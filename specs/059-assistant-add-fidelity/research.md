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

**Limit — the response shape is NOT verified in this container.** Outbound egress to
`api.themoviedb.org` is blocked here: `curl --max-time 10 https://api.themoviedb.org/3/` exits 28
(timeout) while `https://registry.npmjs.org/` returns 200 in the same shell. So the exact nesting of
the appended block, and the certification string for the reported film, are taken from TMDB's
documented shape and MUST be confirmed by a test that runs where egress exists (R4) before the
mapping is called proven. This is a genuine environmental absence, not a capability that can be
restored by a missing file.

---

## R4 — web-api-mcp's integration tier runs NOWHERE today, so the gate must be unit-tier

**Decision**: The merge-blocking coverage for the certification mapping is **unit** tests under
`mcp-servers/web-api-mcp/tests/unit/`, driving `get_movie_details` through a stubbed httpx transport.
The real-TMDB assertion is added to the existing integration suite as well, where it documents and
verifies the live shape for anyone who runs it with egress — but it is not what gates the merge.

**Evidence**:

- `.forgejo/workflows/app-ci.yml:572-578` — "web-api-mcp is deliberately NOT enrolled (048 FR-013)…
  its integration tests reach TMDB, and outbound egress from this runner to api.themoviedb.org is
  unconfirmed; and the credential question is unsettled — TMDB keys are per-user in this design."
- `mcp-servers/web-api-mcp/tests/integration/conftest.py:1-8` — "Runs against the REAL TMDB API —
  never a cassette… without it the tests skip rather than fail." No `MCM_REQUIRE_LIVE_*` escalation
  exists for this suite, so an absent key is a silent skip.
- `.forgejo/workflows/app-ci.yml:226` — `nx affected --target=lint,test,typecheck` **does** run
  `web-api-mcp`'s unit target on every PR. That is the tier that can fail a merge.
- Measured here: TMDB egress blocked (R3), so the integration suite cannot pass in this devcontainer
  either.

**Constitutional check**: stubbing the HTTP transport in a **unit** test is explicitly permitted —
"Unit tests test a single function or class in isolation — external dependencies (HTTP clients…)
MAY be mocked" (§Test Type Integrity). The same stub inside `tests/integration/` would be a
violation. The unit tests therefore live under `tests/unit/` and the integration suite stays real.

**Alternatives considered**: enrolling web-api-mcp's integration suite in CI so the gate could be a
real-TMDB test. Rejected as out of scope — it reopens 048 FR-013's two unresolved questions (runner
egress and whose per-user key a CI run spends), and the E2E job's TMDB usage
(`app-ci.yml:722`) is evidence about the E2E container's network, not this runner's.

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
