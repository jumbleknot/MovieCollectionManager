# Feature Specification: Cancelling a movie search actually exits it

**Feature Branch**: `050-fix-search-cancel-exit`

**Created**: 2026-08-09

**Status**: Draft

**Input**: Backlog item #149 — "Follow up fix from feature 047 - exit search" (`type/bug`, `priority/p2`, component `agents/movie-assistant`).

Reported: in Feature 047 the member asked that a web-search result card offer a way out of the search alongside "Add to collection". Manually testing the shipped behaviour, tapping that cancel action does **not** exit — the assistant answers *"I couldn't find "exit search" in your "Wish List" collection. Want to look elsewhere?"*, i.e. it takes the cancel signal as the title of a brand-new movie search.

Item acceptance criterion: when the cancel button on a movie card is used to leave the movie search, the search MUST be exited directly, and the movie assistant MUST NOT search for "exit search".

## Why this is a bug and not a new capability

Feature 047 User Story 5 already specified this behaviour and it was accepted as delivered:

- **047 FR-032** — a web search result card MUST offer a cancel action alongside "Add to collection".
- **047 FR-033** — cancelling MUST end the search, acknowledge it to the member, and add nothing.
- **047 FR-034** — after cancelling, the member's next message MUST be handled as a fresh request with no leftover search context.
- **047 FR-035** — the cancel action MUST be reachable on both web and mobile.

FR-032 and FR-035 hold: the button is there and reachable. **FR-033 is violated** — the member is not acknowledged, they are answered with a failed search for a phrase they never typed. This specification restores the promised behaviour; it introduces no new member-facing capability.

The defect matters more than a cosmetic wrong answer, because the response the member actually receives *re-opens a search* ("Want to look elsewhere?") at the exact moment they asked to leave one. The escape hatch does the opposite of escaping.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cancelling from a movie card leaves the search (Priority: P1)

A member searches for a movie, is shown web results, picks one, and is given that movie's card. They decide they do not want it after all and use the card's cancel action. The assistant acknowledges that the search has ended. Nothing is added to any collection, and no further search is attempted or offered.

**Why this priority**: This is the reported defect and the whole of the item's acceptance criterion. Without it the escape hatch promised by 047 US5 does not exist in practice, and the member is pushed back into the workflow they asked to leave.

**Independent Test**: Run a web search, pick a result to get its card, use the cancel action, and confirm the reply is an acknowledgement that the search ended — with no mention of a collection, no "couldn't find" message, and no further search offered.

**Acceptance Scenarios**:

1. **Given** a movie card shown as the outcome of a web search, **When** the member uses the card's cancel action, **Then** the assistant acknowledges the search has ended.
2. **Given** the member uses the card's cancel action, **When** the assistant replies, **Then** it does NOT report searching for — or failing to find — the cancel phrase, or any other phrase the member did not type.
3. **Given** the member uses the card's cancel action, **When** the turn completes, **Then** no movie has been added to any collection and no collection has been read on the member's behalf as part of a search.
4. **Given** the member was viewing one of their collections on screen when the search began, **When** they cancel from the card, **Then** the on-screen collection is not searched and is not named in the reply.

---

### User Story 2 - The next message after cancelling is a fresh request (Priority: P1)

Having cancelled, the member types something new. It is treated as a brand-new request with no memory of the abandoned search — no leftover title, scope, collection, or half-finished add.

**Why this priority**: Equal-priority with Story 1 because a cancel that leaves residue is not a cancel. 047 FR-034 already requires it, and the fix for Story 1 must not be allowed to leave the workflow half-alive as a side effect.

**Independent Test**: Cancel from a movie card, then send an unrelated request, and confirm it is handled on its own terms with no reference to the cancelled search.

**Acceptance Scenarios**:

1. **Given** the member has cancelled from a movie card, **When** they send an unrelated next message, **Then** it is handled as a fresh request with no reference to the cancelled search's title, scope, or results.
2. **Given** the member has cancelled from a movie card, **When** they start a brand-new movie search, **Then** the new search resolves its own scope from scratch rather than reusing the cancelled search's collection.

---

### User Story 3 - Cancelling behaves identically on web and mobile (Priority: P2)

A member on the mobile app gets the same result from the card's cancel action as a member on the web app.

**Why this priority**: 047 FR-035 already requires parity, and the defect was reported on one surface only. Parity is verified rather than newly built, so it ranks below the two behavioural stories — but a fix that lands on one surface only would silently re-break the other.

**Independent Test**: Perform the Story 1 flow on the mobile surface and confirm the acknowledgement and absence of a search match the web result.

**Acceptance Scenarios**:

1. **Given** a movie card on the mobile surface, **When** the member uses its cancel action, **Then** the outcome is the same acknowledgement-and-exit as on web.

---

### Edge Cases

- **Cancelling when the search workflow has already ended.** The movie card is the *terminal* step of a search — by the time it is on screen the workflow is over. Cancel must therefore be honoured as an exit even when there is no search left in progress; this is precisely the condition that produces the reported bug.
- **The member types the cancel wording themselves, with no search running at all.** Treated as a request to leave a search: acknowledged, with no search performed. It must never be interpreted as a movie title.
- **Cancelling twice, or after the card has already been used to add.** A second use of either action on the same card must not add anything, must not start a search, and must not error.
- **A stale card from earlier in the conversation.** Cancelling from a card scrolled back to in the transcript, after later turns have moved on, must not disturb whatever the member is doing now beyond acknowledging the exit — and must never start a search.
- **Cancel wording appearing inside a genuine request.** A member asking for a movie whose title happens to contain the cancel wording must still be able to search for it; the cancel signal is a control the member *chose*, not a phrase match on arbitrary prose.
- **The transcript is a record.** Cancelling ends the workflow; it does not erase the card that was already shown, which stays in the conversation as a record of what was offered (carried over unchanged from 047).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Using the cancel action on a movie card MUST end the movie search directly, whatever stage the search workflow is in — including when the workflow has already been cleared because the card is its terminal step.
- **FR-002**: Cancelling MUST produce an acknowledgement that the search has ended.
- **FR-003**: Cancelling MUST NOT cause any search to be performed — not in a collection, not against the external movie source — and MUST NOT report a failure to find anything.
- **FR-004**: The cancel signal MUST NEVER be interpreted as a movie title, and the assistant MUST NOT quote it back to the member as something it looked for.
- **FR-005**: Cancelling MUST NOT add, modify, or delete anything in the member's collections.
- **FR-006**: After cancelling, no search context (title, scope, collection, results) and no half-finished add MUST remain, so that the member's next message is handled as a fresh request.
- **FR-007**: Cancelling MUST NOT offer to continue or restart the search; the reply must be an exit, not a re-entry.
- **FR-008**: The cancel action's outcome MUST be identical on the web and mobile surfaces.
- **FR-009**: Repeated or late use of the card's actions (cancel after cancel, cancel after add, or use of a stale card from earlier in the transcript) MUST NOT add anything, MUST NOT start a search, and MUST NOT surface an error to the member.
- **FR-010**: The routing of the cancel signal to its handler MUST NOT depend on how a language model classifies the member's message — an escape hatch that can be classified away is not an escape hatch. *(Derived from the existing repository pattern for the import-cancel control, which is routed explicitly for this reason.)*
- **FR-011**: The cancel action's outcome MUST be covered by an automated test that fails against the current behaviour and passes after the fix, at the level where the defect actually occurs (the assistant's handling of the cancel signal), not only at the level of the button rendering it.
- **FR-012**: Cancelling MUST be honoured while the assistant is degraded — when the model provider is unreachable, or when the repeated-failure protection has tripped. *(Added during implementation, 2026-08-09.)* FR-010 was written against the classifier alone; building it surfaced two more layers that answer on the model's behalf **before** any routing runs, and both return "Sorry — I couldn't complete that just now" — which is neither an acknowledgement (FR-002) nor an exit (FR-007). The repeated-failure case matters most: that protection trips exactly when a member is likeliest to be stuck and wanting out. This does not extend to the administrative kill switch, where a disabled assistant is required to do nothing at all.

### Key Entities

- **Movie card**: the read-only preview shown for a movie found via web search — the terminal step of a search. Carries an "add to collection" action and, since 047, a cancel action.
- **Search workflow**: the multi-step movie search a member steps through (choose scope, choose collection, pick a result). It ends when a result is opened, a card is shown, or the member cancels.
- **Cancel signal**: the canonical control value the card's cancel action sends to the assistant, agreed between the client and the assistant.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of attempts, using the cancel action on a movie card ends the search in a single turn, with no follow-up needed from the member.
- **SC-002**: Zero collection or external-source searches are triggered by a cancel — measured as no "couldn't find" or "which one?" style reply, and no collection named in the response.
- **SC-003**: The member's cancel phrase is never echoed back as a search subject in any reply — 0 occurrences.
- **SC-004**: After a cancel, the member's next request succeeds on its own terms in 100% of attempts, with no residue from the cancelled search.
- **SC-005**: The behaviour is identical on web and mobile — 0 surface-specific differences in outcome.
- **SC-006**: An automated test reproduces the reported failure before the fix and passes after it, so the regression cannot return silently.

## Assumptions

- The cancel action already present on the movie card (delivered by 047 FR-032/FR-035) is retained; this feature changes what happens when it is used, not whether or how it is offered.
- The client and the assistant continue to agree on a single canonical cancel value. Whether that agreement is expressed as the member's message text or by some other means is a design decision for the plan, not a requirement here — the spec constrains only the observable outcome.
- "Acknowledges the search has ended" means a brief confirmation in the assistant's own voice; the exact wording is not fixed by this spec, but it must not name a collection or invite a further search (FR-003, FR-007).
- Mobile parity is verified against the existing mobile agent flow; no new mobile-only surface is introduced.
- The reported case is the web-search movie card. Any other place the same cancel signal can originate is expected to gain the same corrected behaviour by construction rather than by separate handling; the plan is responsible for confirming this.
- No change to collection data, permissions, or the add flow itself is in scope. A cancel is a read-nothing, write-nothing turn.
