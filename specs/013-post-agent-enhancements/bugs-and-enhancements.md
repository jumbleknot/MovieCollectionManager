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
