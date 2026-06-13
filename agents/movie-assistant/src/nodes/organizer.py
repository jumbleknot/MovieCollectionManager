"""Organizer node: collection/movie writes (HITL-gated) (T041, US1).

The organizer turns the curator's EnrichedMovieCandidate + a target collection into a
Proposal awaiting approval — it performs NO writes here (writes run on the approved-resume
path, Slice E/T044). Code-orchestrated (decided 2026-06-07): the LLM never selects MCP tools
or generates write args; the organizer resolves the target with a `list_collections` READ
and builds the proposal in code via `proposals.build_add_proposal`. Create-if-missing
surfaces the create-collection AND the add in one proposal (FR-005a/FR-006). Target matching
is case-insensitive to mirror mc-service's collation (per-owner name uniqueness).

`build_organizer(list_collections, gen_id)` is the seam: `list_collections` is an async read
(a closure over `invoke_tool` → movie-mcp in production; a stub in tests); `gen_id` mints the
proposal id (uuid4 in production; fixed in tests).

T050 (US2): when `intent == "organize"` and `list_movies` + `plan` are injected, the organizer
takes the model's typed PLAN (code-orchestrated — the LLM never selects tools or forges
payloads), resolves each operation to a movie in the named collection, builds a CHUNKED batch
of proposals (≤50 each, FR-009b), and previews the first batch; remaining batches advance
sequentially through the approval gate. MVP organize scope = multi-item REMOVE (update/move
follow up; the proposals/apply/movie-mcp layers already support update).
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage

from src.proposals import (
    CollectionRef,
    EnrichedMovieCandidate,
    Operation,
    OrganizeOp,
    build_add_proposal,
    build_organize_proposal,
    chunk_operations,
    compose_movie_payload,
)
from src.tools.generative_ui_tools import RENDER_COLLECTION_SUMMARY, render_collection_summary

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
ListMoviesFn = Callable[[str], Awaitable[list[dict[str, Any]]]]
PlanFn = Callable[[Sequence[Any]], dict[str, Any]]
GenIdFn = Callable[[], str]


# A trailing "(YYYY)" the model often echoes onto a title (e.g. "Avatar (2009)"). Anchored to the
# end so a real parenthetical mid-title is untouched — only a 4-digit year at the very end is split.
_TRAILING_YEAR_RE = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")


def _as_int(value: Any) -> int | None:
    """Coerce a year-like value (int or numeric string) to int; None if not numeric."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _split_title_year(text: str) -> tuple[str, int | None]:
    """Split a model-echoed 'Title (Year)' into (bare_title, year|None)."""
    match = _TRAILING_YEAR_RE.search(text)
    if not match:
        return text.strip(), None
    year = int(re.search(r"\d{4}", match.group(0)).group(0))  # type: ignore[union-attr]
    return _TRAILING_YEAR_RE.sub("", text).strip(), year


def _match_movie(op_title: str, movies: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """Resolve a plan op's movie title to a stored movie by (title, year).

    Movie uniqueness is (title, year), so when BOTH the op (e.g. "Avatar (2009)") and a stored film
    carry a year they MUST agree — a bare-title match alone could hit a different same-titled film,
    or collapse two of them. With no year on one side, a UNIQUE title match wins; multiple
    same-title films left ambiguous (or a year matching none) resolve to nothing (never guessed).
    """
    bare, op_year = _split_title_year(op_title)
    fold = bare.casefold()
    matches: list[dict[str, Any]] = []
    for movie in movies:
        if str(movie.get("title", "")).casefold() != fold:
            continue
        movie_year = _as_int(movie.get("year"))
        # When both sides have a year, require agreement; otherwise the title match stands.
        if op_year is not None and movie_year is not None and movie_year != op_year:
            continue
        matches.append(movie)
    return matches[0] if len(matches) == 1 else None


def plan_operations(model: ChatModel, messages: Sequence[Any]) -> dict[str, Any]:
    """Extract the organize plan from the request: which collection + which items to change.

    Returns `{"collection": str|null, "operations": [op, ...]}` where each op is one of:
      - `{"op": "remove", "title": str}` — remove the movie from the collection
      - `{"op": "update", "title": str, "changes": {...}}` — change fields on the movie
      - `{"op": "move", "title": str, "to": str}` — move the movie to the `to` collection
    Defensive `{}`-ish default on any parse failure so the organizer reports "nothing to do"
    rather than acting on a hallucinated plan (the approval gate is still the safety net).
    Pure w.r.t. the model (injected — T050/T032). Supports remove / update / move (T070).
    """
    last = messages[-1].content if messages else ""
    prompt = (
        "Extract a movie-collection organize plan from the user's request.\n"
        'Reply with ONLY JSON: {"collection": string|null, "operations": [ ... ]}. No prose.\n'
        '"collection" is the collection being organized (the source). Each operation is ONE of:\n'
        '  {"op": "remove", "title": string} — remove that movie from the collection\n'
        '  {"op": "update", "title": string, "changes": {...}} — change fields on that movie; '
        '"changes" may set booleans "owned"/"ripped"/"childrens" and/or "addTags"/"removeTags" '
        "(arrays of tag strings)\n"
        '  {"op": "move", "title": string, "to": string} — move that movie to the "to" '
        "collection\n"
        "A movie TITLE is whatever text the user names as the movie — it may read like an "
        'ordinary phrase or sentence (a film can literally be titled "I really want this movie"). '
        "Extract the exact title span VERBATIM; never judge whether it \"looks like\" a real "
        "title, and never drop the operation just because the title is unusual. Use [] for "
        "operations ONLY when the request names no movie operation at all.\n"
        "Examples:\n"
        'move Dune to my Favorites => {"collection": null, "operations": [{"op": "move", '
        '"title": "Dune", "to": "Favorites"}]}\n'
        'remove The Matrix from my list => {"collection": null, "operations": [{"op": "remove", '
        '"title": "The Matrix"}]}\n'
        'mark Inception as owned => {"collection": null, "operations": [{"op": "update", '
        '"title": "Inception", "changes": {"owned": true}}]}\n'
        'move I really want this movie to Movie Collection => {"collection": null, "operations": '
        '[{"op": "move", "title": "I really want this movie", "to": "Movie Collection"}]}\n'
        f"Request: {last}"
    )
    try:
        parsed = dict(json.loads(str(model.invoke(prompt).content)))
    except (ValueError, TypeError):
        return {"collection": None, "operations": []}
    parsed.setdefault("operations", [])
    return parsed


def build_organizer(
    *,
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn | None = None,
    plan: PlanFn | None = None,
    gen_id: GenIdFn | None = None,
) -> Any:
    """Build the organizer graph node from injected reads + id minter (+ US2 plan/list_movies)."""
    new_id: GenIdFn = gen_id or (lambda: str(uuid.uuid4()))

    async def organizer(state: dict[str, Any]) -> dict[str, Any]:
        if state.get("intent") == "organize" and plan is not None and list_movies is not None:
            return await _organize(state, list_collections, list_movies, plan, new_id)
        return await _add(state, list_collections, new_id)

    return organizer


async def _add(
    state: dict[str, Any], list_collections: ListCollectionsFn, new_id: GenIdFn
) -> dict[str, Any]:
    """US1 add path: turn the curator's candidate + target into an add proposal (HITL-gated).

    US3: when the user references the current screen ("add X to this") and named no
    collection, the target is resolved from the sanitized `ui_snapshot` (current collection)
    rather than the default-collection path. An unresolvable "this" → clarify (FR-014).
    """
    candidate: EnrichedMovieCandidate | None = state.get("candidate")
    target_name = str(state.get("target_collection_name") or "").strip()

    if candidate is None:
        return {
            "messages": [
                AIMessage(content="I don't have a movie to add yet — which film did you mean?")
            ],
            "pending_proposal": None,
        }

    collections = await list_collections()

    # US3-AC1/AC2: an explicit current-screen reference resolves to the on-screen collection
    # from the ui_snapshot. "this"/"current"/"here" may surface either as the message ("add X
    # to this") with no extracted collection, OR as the extracted collection name itself (the
    # LLM sometimes returns collection="this") — both mean the current screen, and neither must
    # ever create a literal "this" collection. If it can't be resolved (e.g. on home, or a
    # drifted id), ask which collection — never guess (US3-AC2/FR-014).
    last_text = _last_user_text(state.get("messages", []))
    target_is_current = references_current_screen(target_name) or (
        not target_name and references_current_screen(last_text)
    )
    if target_is_current:
        current = _resolve_current_collection(state.get("ui_snapshot"), collections)
        if current is None:
            names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
            listing = f" You have: {names}." if names else ""
            return {
                "pending_proposal": None,
                "add_stage": "awaiting_collection",
                "messages": [
                    AIMessage(
                        content=(
                            f"I'm not sure which collection you mean by \"this\". "
                            f"Open a collection or tell me its name.{listing}"
                        )
                    )
                ],
            }
        target, needs_clarify = current, False
    else:
        target, needs_clarify = _resolve_target(target_name, collections)
    if needs_clarify:
        # No named/generic target resolvable and no default collection — ask which, never
        # silently create one (T069/R14, RC3; user decision 2026-06-07). Keep the candidate;
        # the next turn names a collection and the curator threads it back here.
        names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
        listing = f" You have: {names}." if names else ""
        return {
            "pending_proposal": None,
            "add_stage": "awaiting_collection",
            "messages": [
                AIMessage(content=f"Which collection should I add {candidate.title} to?{listing}")
            ],
        }

    proposal = build_add_proposal(
        thread_id=str(state.get("thread_id") or ""),
        proposal_id=new_id(),
        candidate=candidate,
        target=target,
        created_in_segment=str(state.get("segment") or ""),
    )

    where = target.name or "the collection"
    movie = f"{candidate.title} ({candidate.year})"
    # Branch the copy so an existing-collection add reads naturally (T073): a create-if-missing
    # names the new collection up front ("create X and add …"); an existing target puts the movie
    # first ("add … to X") — avoids the awkward double-"add" of "add to X and add …".
    if target.create_if_missing:
        content = f'Ready to create "{where}" and add {movie}. Approve to apply.'
    else:
        content = f'Ready to add {movie} to "{where}". Approve to apply.'
    return {
        "pending_proposal": proposal,
        "status": "awaiting_approval",
        "add_stage": "",
        "messages": [AIMessage(content=content)],
    }


async def _organize(
    state: dict[str, Any],
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn,
    plan: PlanFn,
    new_id: GenIdFn,
) -> dict[str, Any]:
    """US2 organize path: model plan → resolve items in the named collection → chunked batch
    preview. Code-orchestrated: the model only names the collection + titles; CODE resolves
    movie ids and builds the idempotent proposals. MVP supports the `remove` op."""
    # Graceful degradation (T061/FR-018): a provider/reasoning failure while extracting the
    # organize plan → a "couldn't complete" reply, never a crash; no proposal is built.
    try:
        parsed = plan(state.get("messages", []))
    except Exception:  # noqa: BLE001 — any model/provider failure degrades gracefully
        return {
            "pending_proposal": None,
            "messages": [
                AIMessage(content="Sorry — I couldn't complete that just now. Please try again.")
            ],
        }
    named_source = str(parsed.get("collection") or "").strip()
    operations = parsed.get("operations") or []

    collections = await list_collections()
    # Source-collection resolution (US3 context): a SPECIFICALLY-named source wins; otherwise an
    # unnamed / generic / "this" source organizes the collection the user is VIEWING (ui_snapshot),
    # NOT the default collection. Bug: on the Wish List screen, "move X to Movie Collection" leaves
    # the source null (the model only fills the destination) → it wrongly searched the default
    # "Movie Collection" and reported "couldn't find X". A spoken target / the default is the
    # last-resort fallback only when there is no current-screen collection.
    source_is_specific = bool(
        named_source
        and named_source.casefold() not in _GENERIC_TARGETS
        and not references_current_screen(named_source)
    )
    if source_is_specific:
        target, _ = _resolve_target(named_source, collections)
    else:
        current = _resolve_current_collection(state.get("ui_snapshot"), collections)
        if current is not None:
            target = current
        else:
            spoken = str(state.get("target_collection_name") or "").strip()
            target, _ = _resolve_target(named_source or spoken, collections)
    if target.collection_id is None:
        # Organize needs an existing collection to act on — ask which.
        names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
        listing = f" You have: {names}." if names else ""
        return {
            "pending_proposal": None,
            "messages": [AIMessage(content=f"Which collection should I organize?{listing}")],
        }

    matched = next(
        (c for c in collections if str(c.get("collectionId")) == target.collection_id), {}
    )
    movies = await list_movies(target.collection_id)

    ops: list[OrganizeOp] = []
    unresolved: list[str] = []
    for operation in operations:
        op_kind = str(operation.get("op"))
        if op_kind not in ("remove", "update", "move"):
            continue
        title = str(operation.get("title") or "").strip()
        # 013 Bug 1: "move/remove/update THIS movie" on a movie-detail screen resolves to the
        # on-screen film via the ui_snapshot — not a literal title match (there is no movie
        # titled "this movie"). An empty title on a movie-detail screen means the same. Matched as
        # the WHOLE title (013 Inc5 Bug 2): a real film that merely CONTAINS "this"/"it" — e.g.
        # "I really want this movie" — must resolve by title, never hijack to the on-screen film.
        wants_current = _is_current_movie_ref(title)
        movie = _resolve_current_movie(state.get("ui_snapshot"), movies) if wants_current else None
        resolved_via_current = movie is not None
        if movie is None:
            # Resolve by (title, year): the model often echoes "Title (Year)" while the stored
            # title is bare, and uniqueness is (title, year) — see _match_movie.
            movie = _match_movie(title, movies)
        if movie is None:
            if title:
                unresolved.append(title)
            continue
        movie_id = str(movie["movieId"])
        # When resolved via the on-screen film, label with its REAL title (not "this movie").
        label = str(movie.get("title", "")) if resolved_via_current else title
        label = label or str(movie.get("title", ""))

        if op_kind == "remove":
            ops.append(
                OrganizeOp(
                    operation=Operation.remove,
                    collection_id=target.collection_id,
                    movie_id=movie_id,
                    label=label,
                )
            )
        elif op_kind == "update":
            # Compose the FULL-replacement payload from the read + the requested changes
            # (mc-service PUT is full-replace; the model only names the changes — T070).
            payload = compose_movie_payload(movie, operation.get("changes") or {})
            ops.append(
                OrganizeOp(
                    operation=Operation.update,
                    collection_id=target.collection_id,
                    movie_id=movie_id,
                    movie_payload=payload,
                    label=label,
                )
            )
        elif op_kind == "move":
            # Move destination must be an EXISTING collection (MVP: never auto-create a move
            # target — an unresolvable destination is reported, not guessed).
            to = str(operation.get("to") or "").strip()
            dest, _ = _resolve_target(to, collections)
            if dest.collection_id is None:
                unresolved.append(f'the "{to}" collection' if to else "the destination collection")
                continue
            if dest.collection_id == target.collection_id:
                # Source == destination (e.g. an unnamed source resolved to the dest collection):
                # a guarded add-then-remove would DELETE the film — report it, never apply.
                unresolved.append(f'"{label}" (already in "{dest.name or to}")')
                continue
            ops.append(
                OrganizeOp(
                    operation=Operation.move,
                    collection_id=target.collection_id,
                    movie_id=movie_id,
                    dest_collection_id=dest.collection_id,
                    movie_payload=compose_movie_payload(movie),
                    label=label,
                )
            )

    if not ops:
        miss = f" I couldn't find: {', '.join(unresolved)}." if unresolved else ""
        return {
            "pending_proposal": None,
            "messages": [
                AIMessage(content=f'I didn\'t find anything to change in "{target.name}".{miss}')
            ],
        }

    batches = chunk_operations(ops)
    proposals = [
        build_organize_proposal(
            thread_id=str(state.get("thread_id") or ""),
            proposal_id=new_id(),
            operations=batch,
            batch_index=i,
            batch_total=len(batches),
            created_in_segment=str(state.get("segment") or ""),
        )
        for i, batch in enumerate(batches)
    ]

    batch_note = f" (batch 1 of {len(batches)})" if len(batches) > 1 else ""
    miss = f" I couldn't find: {', '.join(unresolved)}." if unresolved else ""
    summary_props = render_collection_summary({**matched, "name": target.name})
    preview = AIMessage(
        content=(
            f"Ready to {_action_phrase(ops, str(target.name or ''))}{batch_note}. "
            f"Approve to apply.{miss}"
        ),
        tool_calls=[
            {
                "name": RENDER_COLLECTION_SUMMARY,
                "args": summary_props,
                "id": f"rcs-{target.collection_id}",
            }
        ],
    )
    return {
        "pending_proposal": proposals[0],
        "pending_batches": proposals[1:],
        "status": "awaiting_approval",
        "messages": [preview],
    }


def _action_phrase(ops: list[OrganizeOp], collection_name: str) -> str:
    """Preview verb for an organize batch — op-specific when uniform, generic when mixed (T070)."""
    kinds = {op.operation for op in ops}
    n = len(ops)
    if kinds == {Operation.remove}:
        return f'remove {n} movie(s) from "{collection_name}"'
    if kinds == {Operation.update}:
        return f'update {n} movie(s) in "{collection_name}"'
    if kinds == {Operation.move}:
        return f'move {n} movie(s) out of "{collection_name}"'
    return f'apply {n} change(s) to "{collection_name}"'


# ── US3: current-screen ("this") reference resolution (R15) ─────────────────────────────────

# Keywords that mean "the collection I'm looking at right now" (current screen). Word-bounded
# so "where"/"there" do NOT match "here". Pure detection — no LLM (so no golden re-record).
_CURRENT_SCREEN_RE = re.compile(r"\b(this|current|here)\b", re.IGNORECASE)

# Screens that have a containing collection to resolve "this" against (movie-detail is nested
# under its collection, so "add X to this" there still means the containing collection).
_COLLECTION_SCREENS = frozenset({"collection", "movie-detail"})


def references_current_screen(text: str) -> bool:
    """Whether the user's text references the current screen ("this"/"current"/"here")."""
    return bool(_CURRENT_SCREEN_RE.search(text or ""))


# Generic "the movie I'm viewing" references (movie-detail screen). Matched as the WHOLE op title
# (not a substring) so a real film whose title merely CONTAINS "this"/"it" — e.g. "I really want
# this movie" — resolves by title rather than being hijacked to the on-screen film (013 Inc5 Bug 2).
_CURRENT_MOVIE_REFS = frozenset(
    {"this", "this movie", "this film", "this one", "this title", "it", "the movie",
     "the film", "current movie", "the current movie"}
)


def _is_current_movie_ref(title: str) -> bool:
    """Whether an organize op's movie title is a bare current-screen reference (→ on-screen film).

    True for an empty title or a whole-title generic pronoun ("this movie", "it", …). A real title
    that merely contains "this"/"here"/"current" is NOT a current-screen reference — it must resolve
    by title match (013 Inc5 Bug 2 latent fix; mirrors the substring pitfall fixed there).
    """
    norm = (title or "").strip().casefold().strip(".!?\"'")
    return not norm or norm in _CURRENT_MOVIE_REFS


def _last_user_text(messages: Sequence[Any]) -> str:
    """The most recent human turn's text (skips the curator's AIMessage preview)."""
    for message in reversed(list(messages or [])):
        if getattr(message, "type", None) == "human":
            return str(getattr(message, "content", "") or "")
    return ""


def _resolve_current_movie(
    ui_snapshot: Mapping[str, Any] | None, movies: Sequence[dict[str, Any]]
) -> dict[str, Any] | None:
    """Resolve the movie the user is VIEWING (movie-detail screen) from `ui_snapshot` (013 Bug 1).

    Returns the stored movie whose id matches `ui_snapshot.movie_id` when the current screen is a
    movie-detail (so "move this movie", "remove it", etc. act on the on-screen film), else None.
    Pure code (no LLM → no golden re-record), mirroring `_resolve_current_collection`.
    """
    if not ui_snapshot:
        return None
    if str(ui_snapshot.get("current_screen") or "") != "movie-detail":
        return None
    movie_id = ui_snapshot.get("movie_id")
    if not movie_id:
        return None
    return next((m for m in movies if str(m.get("movieId")) == str(movie_id)), None)


def _resolve_current_collection(
    ui_snapshot: Mapping[str, Any] | None, collections: list[dict[str, Any]]
) -> CollectionRef | None:
    """Resolve the on-screen collection from a sanitized `ui_snapshot`, or None if unresolvable.

    Resolvable only when the current screen has a containing collection AND that collection id
    is one of the user's own collections (a drifted/foreign id → None → clarify, never guess).
    """
    if not ui_snapshot:
        return None
    if str(ui_snapshot.get("current_screen") or "") not in _COLLECTION_SCREENS:
        return None
    collection_id = ui_snapshot.get("collection_id")
    if not collection_id:
        return None
    for collection in collections:
        if str(collection.get("collectionId")) == str(collection_id):
            return CollectionRef(
                collection_id=str(collection["collectionId"]),
                name=str(collection["name"]),
            )
    return None


# Generic references that mean "the user's default collection", not a literally-named one.
_GENERIC_TARGETS = frozenset(
    {"", "my collection", "my collections", "my list", "my movies", "default",
     "default collection", "the collection", "a collection", "my default collection"}
)


def _resolve_target(
    name: str, collections: list[dict[str, Any]]
) -> tuple[CollectionRef, bool]:
    """Resolve the add target to a CollectionRef, or signal that clarification is needed.

    Returns ``(target, needs_clarify)``:
    - a specifically-named target → an existing match (case-insensitive) else create-if-missing;
    - an empty/generic target ("my collection") → the user's `isDefault` collection;
    - an empty/generic target with NO default → ``needs_clarify=True`` (ask which, never create
      a literal "my collection" — T069/R14, RC3).
    """
    lowered = name.casefold().strip()
    if lowered and lowered not in _GENERIC_TARGETS:
        for collection in collections:
            if str(collection.get("name", "")).casefold() == lowered:
                return (
                    CollectionRef(
                        collection_id=str(collection["collectionId"]),
                        name=str(collection["name"]),
                    ),
                    False,
                )
        # A specific new name the user chose → create-if-missing (HITL-gated, FR-005a).
        return CollectionRef(name=name, create_if_missing=True), False

    # Empty/generic target → resolve to the user's default collection (FR-005b/FR-009).
    for collection in collections:
        if collection.get("isDefault"):
            return (
                CollectionRef(
                    collection_id=str(collection["collectionId"]),
                    name=str(collection["name"]),
                ),
                False,
            )
    return CollectionRef(name=name, create_if_missing=True), True
