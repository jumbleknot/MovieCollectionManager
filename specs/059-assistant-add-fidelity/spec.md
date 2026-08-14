# Feature Specification: Assistant add fidelity — the real rating, and the children's question

**Feature Branch**: `059-assistant-add-fidelity`

**Created**: 2026-08-14

**Status**: Draft

**Input**: Two backlog items, both labelled `status/needs-spec`, both landing in the payload the assistant builds for an add:

- **Item #163** (`type/bug`, `priority/p2`) — "Every assistant web-search add is stamped `rated=NR` — the TMDB certification is never fetched (repro: The Secret Life of Pets 2 (2019) is PG)".
- **Item #162** (`type/feature`, `priority/p3`) — "Assistant add flow: ask 'is this a children's movie?' before the ownership question (extends 047 US4)".

## Why these are one feature and not two

Both items are the same defect class in the same place: the assistant writes a **literal it never asked for and never looked up** into every movie it adds. One literal is a false rating; the other is a flag the member is never given the chance to set. They are fixed in the same payload the assistant hands to the movie service, and they are proven by extending the same existing end-to-end add coverage.

Splitting them would put two branches into the same function and the same end-to-end specification file — a guaranteed conflict for no gain, since the two stories assert on different fields and a failure in either is unambiguous. This follows the repository's batching rule: batch by default, split only when a red would be ambiguous.

The user stories are ordered by the items' own priorities: the wrong rating (a `priority/p2` bug that puts false data in a member's library) comes before the missing question (a `priority/p3` capability gap).

## Clarifications

### Session 2026-08-14

- Q: When the certification data cannot be *read* (an error, not an absence), what happens? → A: The certification is obtained in the **same request** as the film's details, so no such state exists — a failed lookup fails the add exactly as today, and "unset" only ever means the source published nothing.
- Q: Does the approval step show the children's answer or the looked-up rating before the member approves? → A: No — the approval step is unchanged. The children's answer rides on the proposal exactly as 047's ownership answers already do.
- Q: Where does the children's question sit relative to the "which collection?" question an unnamed-target add asks? → A: After it — the new question is the first of the questions *about the movie*, and target resolution stays one contiguous step.
- Q: Which certification is recorded when the source publishes several for the US? → A: The first non-empty one in the order the source publishes them — no most-restrictive or release-type rule, so nothing is recorded that no release actually carries.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The rating on an added movie is the film's real rating (Priority: P1)

A member asks the assistant to add a film that the assistant finds through a web search. The movie that appears in their collection carries the film's actual US certification. If the film really has no US certification, the movie's rating is simply blank — the member is not told something about the film that was never established.

Today, every film added this way is stamped **NR** ("not rated"), whatever its real certification. "The Secret Life of Pets 2" (2019) is rated **PG** and lands in the member's library as **NR**.

**Why this priority**: This writes false data into the member's own library, silently, on every single assistant-mediated add. `NR` is not a neutral placeholder — the product treats "not rated" and "unrated" as distinct, substantive ratings, so the assistant is currently making a claim about each film rather than declining to make one. The member has no way to know the value is fabricated, and the longer it ships the more wrong data accumulates.

**Independent Test**: Add a film with a known US certification through the assistant's web search flow and read the created movie's rating; then add a film with no US certification and confirm the rating is blank and the add still succeeded. Neither test needs the children's question to exist.

**Acceptance Scenarios**:

1. **Given** a member adding "The Secret Life of Pets 2" (2019) through the assistant's web search flow, **When** the add completes, **Then** the created movie's rating is **PG**.
2. **Given** a film whose US certification the data source publishes, **When** it is added through the assistant, **Then** the created movie carries exactly that certification, expressed as one of the ratings the product supports.
3. **Given** a film for which the data source publishes **no** US certification, **When** it is added through the assistant, **Then** the movie is created with its rating **unset**, and never as "not rated" or any other substituted value.
4. **Given** a film whose published certification is in a form the product does not recognise, **When** it is added through the assistant, **Then** the movie is created with its rating unset and the add still succeeds — an unfamiliar rating never costs the member the add.
5. **Given** a film the data source genuinely reports as not rated, **When** it is added through the assistant, **Then** the created movie's rating is **NR** — the value is written when, and only when, it is true.
6. **Given** a member importing a spreadsheet, or asking the assistant to change an existing movie, **When** that completes, **Then** the rating behaviour is exactly as it is today — these paths do not consult the external source and are untouched.

---

### User Story 2 - Every assistant-mediated add records whether it is a children's movie (Priority: P2)

A member adds a movie through the assistant. Before being asked whether they own it, they are asked **"Is this a children's movie?"** — a plain yes/no. Whatever they answer, and whatever they go on to say about owning it, the created movie carries that answer.

**Why this priority**: The product already has this flag: it is stored on every movie and editable from the movie edit screen. Only the assistant never asks, so it writes `false` for every film it adds — the exact state the ownership, format and rip-quality fields were in before feature 047. It is a capability gap rather than false data being asserted (`false` is the field's genuine default, and the member can correct it on the edit screen), which is why it sits below User Story 1.

**Independent Test**: Add a movie through the assistant, answer the children's question, and read the flag on the created movie — once answering *yes* to owning it and once answering *no*. Neither test needs the rating fix to exist.

**Acceptance Scenarios**:

1. **Given** a member adding a movie from a web search result card, **When** the assistant begins the follow-up questions, **Then** the children's-movie question is asked **first**, before the ownership question.
2. **Given** a member adding a movie by typing "add &lt;title&gt; to &lt;collection&gt;", **When** the assistant begins the follow-up questions, **Then** the children's-movie question is asked first, and behaves identically to the search-card case.
3. **Given** a member who answers **yes** to the children's question, **When** the add completes, **Then** the created movie is recorded as a children's movie.
4. **Given** a member who answers **no** to the children's question, **When** the add completes, **Then** the created movie is recorded as not a children's movie.
5. **Given** a member who answers the children's question and then answers **no** to owning the movie, **When** the movie is added immediately with no further questions, **Then** it still carries the children's answer they gave — a not-owned children's movie is recorded as a children's movie.
6. **Given** the children's question, **When** the member answers it, **Then** they can do so either by selecting an offered option or by typing their answer, and both reach the same result.
7. **Given** a member part-way through the add questions, **When** they abandon the flow — including at the new first question, before any other question has been asked — **Then** the pending add is discarded and nothing is added.
8. **Given** a member marking an existing movie as a children's movie through another assistant command or the movie edit screen, **When** that completes, **Then** the behaviour is unchanged, and it records the same flag the add-time question sets.
9. **Given** a spreadsheet import or an organize/update path, which never runs the question flow, **When** movies are created, **Then** they are recorded as not children's movies, exactly as today.
10. **Given** a member who asks to add a movie without naming a collection, **When** the assistant asks which collection to add it to, **Then** that question still comes first and the children's question follows once the collection is settled.

---

### Edge Cases

- **The data source publishes several US entries with different certifications** (for example a theatrical rating and a later home-video rating). The first US certification the source publishes that is non-empty is used, so the outcome is deterministic rather than dependent on response ordering luck.
- **The data source publishes a US entry with an empty certification string.** Treated as no certification at all — rating unset, not an empty rating.
- **The film has no US release entry.** Rating unset.
- **The film-detail lookup fails.** Unchanged from today: the add fails the way it already does. Because the certification arrives in that same retrieval (FR-002a), there is no separate "certification unavailable" failure to specify — this feature adds no new failure mode, and never adds a movie with a blank rating in place of an error the member should see. (Feature 047's FR-039 rule about never presenting an incomplete read as complete concerns the member's **own** data; a certification is external data, and its documented absence is a legitimate "unset", not a concealed failure.)
- **The member answers the children's question with something that is neither yes nor no.** The assistant re-asks, exactly as the existing ownership question does for an unparseable answer — the flow does not advance on an answer it did not understand, and it does not guess.
- **The member abandons at the new first question**, before the ownership question has ever been asked. Nothing is added (US2-AC7).
- **A film that is both a children's film and unrated.** The two stories are independent: the children's answer is the member's, the rating is the source's, and neither infers the other. In particular, being a children's movie MUST NOT be used to guess a rating.

## Requirements *(mandatory)*

### Functional Requirements

**Rating fidelity (Story 1)**

- **FR-001**: An assistant-mediated add that resolves a film through the external movie data source MUST record that film's published US certification on the created movie.
- **FR-002**: The certification MUST be obtained from the data source's release/certification data — an actual lookup. It MUST NOT be inferred from the film's genres, overview, title, or any other proxy.
- **FR-002a**: The certification MUST be obtained as part of the **same request** that already retrieves the film's details, adding no further call to the external data source. Consequently there is no state in which the film's details were retrieved but its certification could not be: a failed retrieval fails the add exactly as it does today, and an unset rating (FR-004) can only ever mean the source published no certification — never that a read failed.
- **FR-003**: The published certification MUST be expressed as one of the ratings the product supports — the controlled vocabulary `G`, `PG`, `PG-13`, `R`, `NC-17`, `NR`, `Unrated`. A certification outside that vocabulary is handled by FR-006.
  - *Corrected 2026-08-14 during planning.* Item #163's AC3 asks for a rename of `PG-13` → `PG13` and `NC-17` → `NC17`. That rename does not exist at any boundary this feature touches: those are internal identifiers in one implementation language, and the values actually exchanged and stored are `PG-13` and `NC-17`, matching the published certification exactly. The requirement is therefore **validation against the vocabulary**, not translation into it. Implementing AC3 literally would write two values the product does not accept.
- **FR-003a**: When the data source publishes more than one US certification for a film, the **first non-empty** one in the order the source publishes them MUST be recorded. The rating MUST NOT be derived by combining entries — no most-restrictive-wins rule and no release-type preference — so a rating no individual release carries can never be written.
- **FR-004**: When the data source publishes no US certification for the film, the movie MUST be created with its rating **unset**.
- **FR-005**: The rating "not rated" MUST be recorded only when the data source actually reports the film as not rated. It MUST NOT be used as a placeholder for an absent, unknown, or unrecognised certification.
- **FR-006**: A published certification in a form the product does not recognise MUST be treated as unset (FR-004) and MUST NOT fail the add.
- **FR-007**: Adds that do not consult the external data source — spreadsheet import, and the organize/update paths that change an existing movie — MUST be unchanged by this feature.

**The children's-movie question (Story 2)**

- **FR-008**: Every assistant-mediated add MUST ask whether the movie is a children's movie, and MUST ask it **before** the ownership question, as the first of the questions asked *about the movie*.
- **FR-008a**: When the add did not name a collection and the assistant must ask which collection to add to, that question MUST still come first: the order is collection → children's → ownership → the rest. Abandoning while the collection is still unsettled MUST NOT reach the children's question.
- **FR-009**: The question MUST be asked regardless of what the member answers about ownership, including the not-owned case that adds the movie immediately with no further questions (047 FR-025).
- **FR-010**: The created movie MUST carry exactly the answer the member gave.
- **FR-011**: The question MUST be a simple yes/no. It MUST NOT use the toggle-list-plus-confirm control, which 047 FR-020a specifies for the multi-valued selections (media formats, rip qualities) only.
- **FR-012**: The question MUST be answerable either by selecting an offered option or by typing the answer, both reaching the same result (047 FR-036 parity).
- **FR-013**: Abandoning the add MUST discard the pending add and add nothing, including when the member abandons at this new first question (047 FR-029 parity).
- **FR-014**: The question MUST behave identically whether the add started from a web search result card or a typed "add &lt;title&gt; to &lt;collection&gt;" command (047 FR-031 parity).
- **FR-015**: Callers that do not run the question flow MUST continue to create movies as not children's movies — the flag's default MUST remain additive, so no existing caller has to change.
- **FR-016**: Marking an already-existing movie as a children's movie through other assistant commands, or through the movie edit screen, MUST be unchanged (047 FR-031a parity), and MUST set the same flag the add-time question sets — "mark X as a kids movie" and answering *yes* to the new question MUST resolve to the same thing.

**Cross-cutting**

- **FR-017**: The rest of the add chain — the ownership question, the media formats, the ripped question, the rip qualities, and the rules that formats are recorded only for an owned movie and qualities only for a ripped one — MUST be unchanged in behaviour by the insertion of the new first question (047 FR-020 … FR-028).
- **FR-018**: Every write in these flows MUST remain behind the existing explicit-approval step (047 FR-037), and a member MUST never be shown or able to act on a collection or movie that is not theirs (047 FR-038).
- **FR-018a**: The approval step itself MUST be unchanged — it MUST NOT gain a readback of the children's answer or of the looked-up rating. Both ride on the pending add exactly as 047's ownership, format and rip-quality answers already do, so an approval arriving on a later turn still applies exactly what the member chose.
- **FR-019**: After a successful add the member MUST still be taken to the new movie's detail screen (047 FR-030).
- **FR-020**: The behaviour that can be verified without a model's judgement — the certification mapping in all its cases, and the values the add payload carries — MUST be pinned by merge-blocking automated tests. The conversational flow proofs, which depend on the model choosing tools, extend the existing agent end-to-end coverage in its non-blocking tier. No requirement of this feature may be left with **no** test that runs.
- **FR-020a**: The check that the certification is read correctly **from the real external source** MUST run automatically on the merge path — in the development environment and in continuous integration alike. It MUST NOT be a manual step, and an environment that cannot reach the source is to be **fixed**, not documented around. Where such a check skips when its credential or network is absent, that skip MUST be treated as a failure, because a clean skip is indistinguishable from a pass.
- **FR-021**: The existing end-to-end coverage of the 047 ownership chain MUST be updated for the new question. That coverage walks a fixed sequence of turns; an extra question ahead of the ownership question changes that sequence, so coverage left unchanged would be asserting a flow that no longer exists.

### Key Entities

- **Movie (as created by the assistant)**: The record added to a member's collection. Two of its attributes are the subject of this feature — its **rating**, which is optional and today always written as "not rated", and its **children's-movie flag**, which is a plain true/false and today always written as false.
- **Enriched film candidate**: The description of a film the assistant obtains from the external data source before proposing an add — title, year, overview, genres, poster, language. It carries **no rating today**; Story 1 adds one.
- **Add question chain**: The ordered sequence of follow-up questions between the member choosing a film and the movie being created. Today: ownership → (if owned) formats → ripped → (if ripped) qualities. Story 2 makes the children's question its new first step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Adding "The Secret Life of Pets 2" (2019) through the assistant's web search flow produces a movie whose rating reads **PG**, where today it reads **NR**.
- **SC-002**: Across a set of films with known, differing US certifications, **100%** of movies added through the assistant carry the film's real certification — no rating written that the data source did not publish.
- **SC-003**: For a film with no published US certification, the movie is created with a blank rating and the add succeeds — **0** adds lost to a missing or unfamiliar rating.
- **SC-004**: **100%** of assistant-mediated adds record a children's-movie answer given by the member, including adds where the member said they do not own the film.
- **SC-005**: Every question in the add chain, including the new first one, can be completed by typing only, and by tapping only — both routes produce identical movies.
- **SC-006**: Abandoning an add at any point in the chain, including at the new first question, leaves the member's collection unchanged — **0** movies added.
- **SC-007**: Movies created by the spreadsheet import and by the organize/update paths are byte-for-byte unchanged in these two fields from today's behaviour.

## Assumptions

- **Which certification, when the source publishes more than one for the US**: settled in Clarifications and stated as FR-003a — the first non-empty one published. Certification data is per-release and a film can carry several; a deterministic pick is preferred to a rule the member cannot predict, and to a combining rule that would write a rating no release actually carries. No member-facing choice is offered.
- **Shared vocabulary for the children's flag**: the add-time answer and the existing conversational "mark X as a kids movie" update resolve to the same flag (FR-016). This settles item #162's stated open question in favour of reuse; the alternative — a second, add-only vocabulary — would let the two paths drift.
- **The rating is not shown before the add**: the certification is written to the created movie but is not surfaced on the web search preview card. The member sees it on the movie detail screen after the add, which is where the defect was noticed. Adding it to the preview card is a separate, purely presentational change and is out of scope here.
- **Existing wrongly-stamped movies are not repaired**: movies already in members' libraries carrying a false `NR` are left alone. Backfilling them means re-querying the data source for every movie with an external identifier and an `NR` rating, and cannot distinguish a wrongly-stamped `NR` from one a member set deliberately. Item #163 states this explicitly; it is a separate decision and a separate backlog item if wanted.
- **No storage or service change is needed**: both fields already exist on the movie record, are already persisted, and are already editable from the movie edit screen. This feature adds no new stored field and no migration.
- **The external data source's certification data is available under the existing access arrangement** — no new credential, quota tier, or contractual change is assumed. The automated live check (FR-020a) spends the credential the project already holds for continuous integration; it adds usage, not a new arrangement.
- **Reaching the source from the development environment is part of this feature, not a precondition of it.** The environment previously permitted the running application to reach the source but not the test runner. That was corrected here rather than worked around, because a verification that only a person can run is one that stops being run.
