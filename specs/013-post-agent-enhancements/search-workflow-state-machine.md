# US7 — Unified Search Workflow State Machine

The assistant search workflow (`agents/movie-assistant/src/nodes/search.py`) is a **pure-code
multi-turn state machine**. The supervisor's `search` intent is the only LLM/model decision; once
inside the node, every resolution, disambiguation, and pick is deterministic code (so it carries no
golden-cassette surface). Button taps post canonical text that re-enters the node and advances the
stage (mirrors the T069 add state machine).

## State field (`GraphState`)

| Field | Values | Meaning |
|---|---|---|
| `search_stage` | `''` \| `awaiting_scope` \| `awaiting_collection` \| `awaiting_pick` | where in the flow |
| `search_scope` | a collection id \| `web` \| `''` | what the current results are from |
| `search_query` | the movie title | carried across button-tap turns |
| `search_results` | `[{title, year, …, kind: owned\|web}]` | candidates awaiting a pick |

All four are cleared on a **terminal** turn (navigate / web card / exit / no-title). Nothing here
is a credential (SC-004).

## Flow

```mermaid
flowchart TD
    U([user turn]) --> SUP{supervisor}
    SUP -->|"'search' intent:<br/>show me / find / look up /<br/>open / go to &lt;movie&gt;"| FRESH
    SUP -->|"search_stage set →<br/>re-enter (button tap)"| CONT
    SUP -.->|"add / organize →<br/>escape + clear"| ESC([leave workflow])

    %% ---------- fresh search ----------
    FRESH["stage='' (fresh)"] --> EX["extract title — PURE CODE<br/>strip lead verb + 'in &lt;collection&gt;' clause<br/>(never injects an article)"]
    EX --> T{title?}
    T -->|no| ASK["reply: 'What movie would<br/>you like to search for?'"] --> DONE
    T -->|yes| LC[list_collections]
    LC --> Z{any collections?}
    Z -->|none| WEB
    Z -->|yes| RC["resolve target collection:<br/>named → current-screen (ui_snapshot)<br/>→ default → only"]
    RC --> R{resolved?}
    R -->|"yes"| OWNED
    R -->|">1, none"| SCOPE

    %% ---------- owned search ----------
    OWNED["owned search:<br/>list_movies(search=stripped),<br/>article-insensitive match (US8)"] --> OC{matches}
    OC -->|0| NONE["'not in &lt;name&gt;'<br/>+ control buttons"] --> PICK
    OC -->|1| NAV["navigate_to_movie ✅"] --> DONE
    OC -->|"&gt;1 (Bug 2)"| RES["result buttons +<br/>control buttons"] --> PICK

    %% ---------- web search ----------
    WEB["web search:<br/>web-api-mcp search_title"] --> WCnt{results}
    WCnt -->|0| WNONE["'not on TMDB'<br/>+ control buttons"] --> PICK
    WCnt -->|1| CARD["TMDB preview card ✅<br/>(US10: url + add affordance)"] --> DONE
    WCnt -->|"&gt;1"| WRES["web result buttons +<br/>control buttons"] --> PICK

    %% ---------- awaiting states ----------
    SCOPE["stage=awaiting_scope<br/>[Search a collection] [Search the web]"]
    COLLB["stage=awaiting_collection<br/>collection-name buttons (≤5 + view more)"]
    PICK["stage=awaiting_pick<br/>results + controls"]

    %% ---------- continuation dispatch (a tap posts canonical text) ----------
    CONT{search_stage}
    CONT -->|awaiting_scope| S{tap}
    S -->|Search the web| WEB
    S -->|Search a collection| COLLB
    CONT -->|awaiting_collection| C{tap = name}
    C -->|matched| OWNED
    C -->|no match| COLLB
    CONT -->|awaiting_pick| P{tap}
    P -->|"a result<br/>(year / title / ordinal / #)"| K{kind}
    K -->|owned| NAV
    K -->|web| CARD
    P -->|Search another collection| COLLB
    P -->|Search the web| WEB
    P -->|unresolved| PICK
    CONT -.->|"'exit search' / exit / cancel<br/>(any stage)"| EXIT["reply: 'exited search' ✅"] --> DONE

    SCOPE --> CONT
    COLLB --> CONT
    PICK --> CONT

    DONE([clear search_* state])

    classDef term fill:#dff0d8,stroke:#3c763d;
    classDef stage fill:#fcf8e3,stroke:#8a6d3b;
    class NAV,CARD,EXIT,ASK term;
    class SCOPE,COLLB,PICK stage;
```

## Compact stage reference

| Stage | On entry shows | A tap of… | goes to |
|---|---|---|---|
| `''` (fresh) | — (resolves + runs a search) | — | owned / web / scope / ask |
| `awaiting_scope` | `Search a collection` · `Search the web` | "Search the web" | web search |
| | | "Search a collection" | `awaiting_collection` |
| `awaiting_collection` | collection-name buttons (≤5 + view more) | a collection name | owned search there |
| `awaiting_pick` | result buttons + controls | a result (year/title/ordinal/#) | navigate (owned) / card (web) |
| | | "Search another collection" | `awaiting_collection` |
| | | "Search the web" | web search |
| | | "Exit search" | exit (clear) |

## Invariants

- **Bug 1 fix** — collection resolution is *named → current-screen → default → only*; never sums
  across collections.
- **Bug 2 fix** — `>1` owned/web matches always **disambiguate** (buttons); only a single
  unambiguous match auto-navigates / auto-cards.
- **Bug 3 fix** — title extraction is pure code → never injects an article; matching is
  article-insensitive (`text_match.titles_match`, US8).
- **Pure-code picks** — `resolve_option` (year → title → ordinal → index) resolves a tap against
  `search_results`; no model call, so no golden re-record.
- **Reachable by construction** — reads return only the user's OWN collections/movies (downscoped
  token), so an emitted `navigate_to_movie` target is always one the user could reach (DAC parity).
- **Terminals clear state** — navigate, web card, exit, and no-title all reset `search_*` so a
  finished search never leaks into the next turn.
