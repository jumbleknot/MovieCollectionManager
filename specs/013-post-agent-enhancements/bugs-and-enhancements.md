# Bugs and Enhancements

## Bug 1 - generic collection name not resolved

when I asked to show a movie in "my collection" it did not resolve as either the current collection I was in or the default collection.  related to "New Scope 1" below.

- me: show me avatar in my collection
- assistant: You have 11 movie(s) across 2 collection(s).

## Bug 2 - open first movie in match list

when I asked to navigate to a movie in a specific collection which had multiple movies that started with the same search string, the assistant navigated me to the first movie that matched without asking me to clarify which movie.  related to "New Scope 1" below.

- me: navigate to Avatar in movie collection
- assistant: Opening "Avatar".

## Bug 3 - search failing on articles

when I asked to navigate to a movie in a specific collection, the assistant appended "the" to the beginning of the movie name and failed to match on an existing movie.  this shows two issues (a) the assistant appended "the" to the search string, and (b) the assistant should be able to find matches with or without articles (e.g., "a", "the", ...).  Also related to "New Scope 2".

- me: show me secret of nimh in this collection
- assistant: "The Secret of NIMH" isn't in your "Movie Collection" collection.

## New Scope 1 - assistant search workflow

when the user prompts with the search key words (e.g., search [movie], open [movie], navigate to [movie], go to [movie], show me [movie], look up [movie], find [movie], [movie]) the assistant should kick off the assistant search workflow as defined below:

- if the prompt specifies the collection name, search the named collection
- if the prompt doesn't specify the collection name
  - if there are no collections, search the web (TMDB)
  - if the user is in a collection, search the collection the user is currently in
  - if the user is not in a collection and there is a default collection, search the default collection
  - if the user is not in a collection and there is no default collection but there is exactly 1 collection, search the only collection
  - if the user is not in a collection and there is no default collection and there is more than 1 collection, display disambiguation buttons for "search a collection", "search the web"
    - if the user selects "search a collection", display disambiguation buttons with the collection names (cap at 5 with "view more" option), and search the collection the user selects
    - if the user selects "search the web", search the web
- when the prompt from search a collection returns
  - if there are no results, state no match found and display disambiguation buttons for "search another collection", "search the web", "exit search"
    - if the user selects "search other collections", display disambiguation buttons with the collection names (cap at 5 with "view more" option), and search the collection the user selects
    - if the user selects "search the web", search the web
    - if the user selects "exit search", exit the assistant search workflow
  - if there are 1 or more results, show the disambiguation buttons for the results (cap at 5 with "view more" option), "search another collection", "search the web", "exit search"
    - if the user selects one of the movies in a collection, navigate to it
    - if the user selects "search other collections", display disambiguation buttons with the collection names (cap at 5 with "view more" option), and search the collection the user selects
    - if the user selects "search the web", search the web
    - if the user selects "exit search", exit the assistant search workflow

## New Scope 2 - ignore movie title articles during sort

The sort capability implemented in this feature is currently sorting on articles in movie titles (e.g., "a", "the", ...), but these articles should be ignored when sorting.

## New Scope 3 - clickable URL in assistant TMDB movie card

When the assistant returns a movie card from TMDB when doing a web search, the movie card should have a clickable URL to the movie following the exact same rules and pattern as the clickable TMDB URL that is created when the movie is added to the collection.  This way the user can view the movie details on TMDB before deciding to add it to the collection.

---

# Increment 3 — post-Claude-testing findings (2026-06-12)

Found while testing the agent against Claude (provider=anthropic).

## Bug 1 — "move this movie" on the movie-detail screen is not resolved

On a movie's detail page, "move this movie to <collection>" failed: the organizer resolved the
SOURCE collection to the current screen ("Wish List") but could not resolve the movie ("I didn't
find anything to change in 'Wish List'"). The op title "this movie" must resolve to the CURRENT
movie via the `ui_snapshot.movie_id` (movie-detail screen), not be matched as a literal title.
Same current-screen discipline as "add X to this" (US3) — extended to the move/update/remove
*movie* on a detail screen.

## Bug 2 — "look up <movie>" does not start the search workflow

"look up the matrix" routed to `enrich` (curator TMDB lookup → disambiguation) instead of the
unified `search` workflow. Per New Scope 1, "look up" is a search trigger. The supervisor must
route a bare "look up / search for / find <movie>" to `search`; only explicit external-info
phrasings ("tell me about", "what year was", "who directed", "give me details/a preview of") stay
`enrich`. (Golden re-record; verify on Claude AND qwen2.5.)

## Enhancement 1 — collection choices as clickable buttons

When the assistant asks which collection to open ("go to collections" → "Which collection would
you like to open? You have: Wish List, Movie Collection."), the collections must render as
clickable disambiguation buttons (the `render_selection` mechanism, cap 5 + "view more"), like the
other assistant choices. A tap opens that collection. Applies to the navigator's "which
collection" clarify (and the sibling organize/query clarifies).

---

# Increment 5 — post-Claude-testing findings + orchestration concern (2026-06-13)

Found while testing the agent against Claude (provider=anthropic, production nodes ON). Each item
below is evidence-backed (reproduced against the live runtime/Claude models — see the per-item
notes). One coordinated golden re-record covers every model-decision change (supervisor intent +
organizer plan + query extraction), recorded on qwen2.5 AND Claude, then replayed green.

## Concern — `query`/`search` "find" overlap (separation of responsibilities)

The `query` node carried a third answer shape, **find** (a named `movie_title` → search the user's
own collection → movie card / "isn't in your collection"), which overlaps `search`. Decision:
`query` is limited to **count** and **list** (+ the all-collections sum); `search` becomes the
**only** node that locates a specific movie. Existence questions ("do I have X", "is X in my
collection") re-route from `query` to `search`, which **locates + opens** the movie (or
disambiguates / offers the web fallback) — the user-approved behavior. Pure-code title extraction
in `search` is extended to strip existence lead-ins ("do I have / do I own / is / have I got
<X>") so the title isolates correctly. (Supervisor intent prompt changes → golden re-record.)

## Bug 1 — web-search card "Add to collection" adds to the default, not the current collection

While viewing "Wish List", a web (TMDB) search → pick a result → the preview card's "Add to
collection" added the movie to "Movie Collection" (the default) instead of "Wish List". Root cause:
`render_movie_card`'s add affordance posts a bare `add <Title> (<Year>)` with no collection
context, and the web card carries `collectionId: null`, so the organizer falls back to the default
collection. Fix: thread the in-context collection (the `search_scope` the user searched in) onto
the web card and post `add <Title> (<Year>) to <CollectionName>`; bare add only when there is no
collection context (zero collections). No model change.

## Bug 2 — organizer drops a sentence-like movie title ("I didn't find anything to change")

On the "Wish List" collection screen, `move I really want this movie to Movie Collection` (where
"I really want this movie" is the literal movie title) replied "I didn't find anything to change in
'Wish List'." Evidence: `plan_operations` on **Claude sonnet-4-6** returns `operations: []` — it
doesn't recognize the sentence-like span as a title (qwen2.5 parses it correctly, so this was
Claude-only). Fix: revise the `plan_operations` prompt so a title is extracted **verbatim**
regardless of whether it "looks like" a title, and the op is never dropped for an unusual title
(few-shot incl. the sentence-like title — validated on Claude). Also a **latent correctness bug**:
the organizer's `references_current_screen(title)` does a *substring* match, so a real title
containing "this"/"here"/"current" would hijack to the on-screen film on a movie-detail page —
replaced with a whole-title generic-pronoun match. (Plan prompt change → golden re-record.)

## Bug 3 — "move this movie to <collection>" misrouted to navigate (hangs)

On a movie-detail page, `move this movie to movie collection` replied "Opening 'Wish List'." →
"Opening that collection…" → hung. The organizer already resolves "this movie" via
`ui_snapshot.movie_id`, but the **supervisor misrouted the request to `navigate`** (the destination
name "movie collection" cued the navigate label), so the organizer never ran; the deep navigation
then reset the dock. Fix: harden the supervisor rule — `mark/set/move/remove/rename/sort/tag/update`
are **always organize**, never navigate/search/query, even when the target name contains
"movie"/"collection"; add an example. (Intent prompt change → golden re-record.)

---

# Increment 5 (cont.) — second testing round (2026-06-13)

Bugs 1–3 + the nav-dedup fix confirmed fixed by the user. Two further items:

## New bug 1 — organize doesn't match a partial movie title

In "Wish List" (which held "Harry Potter and the Order of the Phoenix"), `move harry potter to
Movie Collection` replied "I didn't find anything to change in 'Wish List'. I couldn't find: harry
potter." The organizer resolves an op's title by **exact `(title, year)`** only, so a partial name
never matches. Fix (mirror the search workflow, pure code — no model/golden change): resolve a
title by exact `(title,year)` → else **article-insensitive substring** match; *unique* → use it
(straight to the approval preview — user decision); *multiple* → a `render_selection`
disambiguation of the matching **owned** movies (NO "search the web" — these are already-owned
movies) whose tap is resolved in pure code (`resolve_option`) and applied through the normal
approval gate; *none* → "couldn't find" (today). New `organize_stage`/`organize_pending`/
`organize_options` state + a supervisor-continuation branch like `search_stage`. Disambiguation is
scoped to a **single-operation** request (a multi-item plan keeps exact/substring-unique matching).
Applies to move/remove/update (shared matcher). **Titles with AND without a year must both work** —
the substring match is year-agnostic (a year in the request, when present, still disambiguates),
and a candidate button label / pick token is "Title (Year)" when a year exists, else "Title".

## New enhancement 1 — auto-scroll the dock to the bottom after a card renders

After a card (movie card / selection / collection summary) appears in the assistant dock, the chat
should auto-scroll to the bottom. The FlatList already has `onContentSizeChange={scrollToLatest}`
but it doesn't fire reliably once a card's async content (poster image) lays out → the card lands
below the fold. Fix: an effect that defers a `scrollToEnd` a tick after a tool/card item is
appended, complementing `onContentSizeChange`.

## New bug 2 — a single collection-search result auto-navigates instead of offering a button

Searching a collection that returns exactly ONE owned result navigated straight to the movie
instead of showing it as a disambiguation button. This contradicts New Scope 1 ("if there are 1 or
more results, show the disambiguation buttons … plus 'search another collection', 'search the web',
'exit search'"). Root cause: `search._run_owned` had an `if len(matches) == 1: navigate` special
case (the old AC8). Fix: remove it — ANY owned result(s), including exactly one, are offered as
buttons + the control buttons; `navigate_to_movie` fires only when the user taps a result (the
`awaiting_pick` pick path is unchanged). A single **web** result still renders its preview card
directly. Pure-code; no model/golden change. (Also adds a "Cancel Move/Remove/Update" control
button to the organize partial-title disambiguation — see the move-movie note.)
