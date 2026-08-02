"""Pure-code import disambiguation (US4, feature 014).

When the import node can't confidently resolve something — a tab's target collection (0 or >1
name match, FR-010), a medium-confidence column (FR-012), or an uncertain trailing sorting word
(FR-015) — it surfaces a button prompt rather than guessing (SC-006/SC-007). This module is
PURE: it detects what to ask (`collect_import_disambiguations`), resolves a tapped button
(`resolve_import_pick`, reusing the supervisor's deterministic `resolve_option`), and records the
choice into an accumulating `resolutions` dict (`apply_import_pick`). No LLM, no graph, no IO —
the `import` intent is the only golden surface; everything here is exhaustively unit-testable.

The `resolutions` accumulator the node threads across turns:
    {
      "collection": { tab_name: collection_id },
      "column":     { header: attribute | "__ignore__" },
      "article":    { original_title: chosen_title },
    }
`build_import_preview` consults it so a confirmed choice is applied and never re-asked.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from src.nodes.import_collection import resolve_tab_collection
from src.nodes.import_resolvers import IGNORE_COLUMN, normalize_title_article, resolve_columns
from src.nodes.supervisor import resolve_option


@dataclass(frozen=True)
class ImportPrompt:
    """A pending disambiguation surfaced to the user as buttons (US4).

    `options` are button dicts; each carries a `title` label so the shared `resolve_option` can
    match a typed-back label / ordinal / index, plus the kind-specific value the pick records
    (`collectionId` / `attribute` / `title`).
    """

    kind: str  # "collection" | "column" | "article"
    key: str  # tab_name (collection) | header (column) | original_title (article)
    question: str
    options: list[dict[str, Any]] = field(default_factory=list)


def _resolved(resolutions: Mapping[str, Any], kind: str) -> Mapping[str, Any]:
    section = resolutions.get(kind) if resolutions else None
    return section if isinstance(section, Mapping) else {}


def collect_import_disambiguations(
    tabs: Sequence[dict[str, Any]],
    collections: Sequence[dict[str, Any]],
    resolutions: Mapping[str, Any],
) -> list[ImportPrompt]:
    """Scan eligible tabs for everything still needing a user decision (collections, then columns,
    then articles). Already-resolved items (present in `resolutions`) are suppressed."""
    resolved_collection = _resolved(resolutions, "collection")
    resolved_column = _resolved(resolutions, "column")
    resolved_article = _resolved(resolutions, "article")

    collection_prompts: list[ImportPrompt] = []
    column_prompts: list[ImportPrompt] = []
    article_prompts: list[ImportPrompt] = []
    seen_columns: set[str] = set()
    seen_titles: set[str] = set()

    for tab in tabs:
        if not tab.get("eligible"):
            continue
        name = str(tab.get("name", ""))

        # Tab → collection (FR-010): 0 or >1 name match and not yet chosen.
        if name not in resolved_collection:
            target, options = resolve_tab_collection(name, collections)
            if target is None:
                collection_prompts.append(_collection_prompt(name, options))

        # Medium-confidence column (FR-012): ask which attribute (or ignore).
        for mapping in resolve_columns(tab.get("columns", [])):
            if mapping.confidence != "medium" or mapping.header in resolved_column:
                continue
            if mapping.header in seen_columns:
                continue
            seen_columns.add(mapping.header)
            column_prompts.append(_column_prompt(mapping.header, mapping.candidates))

        # Uncertain trailing sorting word (FR-015): ask before reordering.
        for row in tab.get("rows", []):
            raw = str(row.get("Title") or row.get("title") or "")
            # Compare on the TRIMMED title, because that is what the prompt keys and records
            # (047 FR-007/FR-011). The row still carries the raw cell value, so an untrimmed
            # comparison here would fail to see a decision the member has already made and
            # would re-ask it on every pass — the second half of the 047 US2 loop.
            title = raw.strip()
            if not title or title in resolved_article or title in seen_titles:
                continue
            norm = normalize_title_article(title)
            if norm.needs_confirm:
                seen_titles.add(title)
                article_prompts.append(_article_prompt(title))

    return collection_prompts + column_prompts + article_prompts


def _collection_prompt(tab_name: str, candidates: Sequence[dict[str, Any]]) -> ImportPrompt:
    options = [
        {
            "id": str(c.get("collectionId")),
            "title": str(c.get("name") or ""),
            "collectionId": str(c.get("collectionId")),
        }
        for c in candidates
    ]
    return ImportPrompt(
        kind="collection",
        key=tab_name,
        question=f'Which collection should the "{tab_name}" tab import into?',
        options=options,
    )


def _column_prompt(header: str, candidates: Sequence[str]) -> ImportPrompt:
    options = [{"id": attr, "title": attr, "attribute": attr} for attr in candidates]
    options.append({"id": IGNORE_COLUMN, "title": "Ignore this column", "attribute": IGNORE_COLUMN})
    return ImportPrompt(
        kind="column",
        key=header,
        question=f'What does the "{header}" column hold?',
        options=options,
    )


def _article_prompt(raw_title: str) -> ImportPrompt:
    """Build the sorting question for an uncertain trailing comma-word.

    The key and every option label are the TRIMMED title, never the raw cell value (047
    Rule N1). Keeping the raw value was the 047 US2 defect: a label carrying a trailing
    space is LONGER than the trimmed reply a tap posts back, so `resolve_option`'s
    substring step could never match it — nothing resolved, nothing was recorded, and the
    question re-fired forever. Trimming here also aligns the recorded key with
    `build_row_payload`'s `article_overrides` lookup, which has always used the trimmed
    title (`_coerce_value` strips), so a recorded choice is now actually applied.
    """
    title = raw_title.strip()
    options = [{"id": "keep", "title": title}]
    reordered = _reorder_trailing(title)
    if reordered and reordered != title:
        options.append({"id": "reorder", "title": reordered})
    return ImportPrompt(
        kind="article",
        key=title,
        question=f'How should "{title}" be sorted?',
        options=options,
    )


def _reorder_trailing(title: str) -> str:
    """Move the final comma-suffix to the front ("Goodbye, Lenin!" → "Lenin! Goodbye")."""
    idx = title.rfind(",")
    if idx < 0:
        return title
    head, suffix = title[:idx].strip(), title[idx + 1 :].strip()
    return f"{suffix} {head}".strip() if head and suffix else title


# Render-selection styling per prompt kind (client button colour; coerced if unknown).
_KIND_STYLE = {"collection": "collection", "column": "control", "article": "control"}


def to_selection_options(prompt: ImportPrompt) -> list[dict[str, str]]:
    """Map an ImportPrompt to `render_selection` button props `[{label, value, kind}]`.

    `value` is the option's title — the canonical text a tap posts back through the dock, which
    `resolve_import_pick` matches in pure code (no client-side state mutation, 013 pattern)."""
    style = _KIND_STYLE.get(prompt.kind, "control")
    return [
        {"label": str(o.get("title") or ""), "value": str(o.get("title") or ""), "kind": style}
        for o in prompt.options
    ]


def resolve_import_pick(text: str, prompt: ImportPrompt) -> dict[str, Any] | None:
    """Resolve a user's reply to one of the prompt's button options (pure, no LLM)."""
    return resolve_option(text, prompt.options)


def apply_import_pick(
    resolutions: Mapping[str, Any], prompt: ImportPrompt, chosen: Mapping[str, Any]
) -> dict[str, Any]:
    """Record a resolved pick into a NEW resolutions dict (the input is never mutated)."""
    updated: dict[str, Any] = {
        "collection": dict(_resolved(resolutions, "collection")),
        "column": dict(_resolved(resolutions, "column")),
        "article": dict(_resolved(resolutions, "article")),
    }
    if prompt.kind == "collection":
        updated["collection"][prompt.key] = str(chosen.get("collectionId"))
    elif prompt.kind == "column":
        updated["column"][prompt.key] = str(chosen.get("attribute"))
    elif prompt.kind == "article":
        # Both sides trimmed (047 Rule N1). `_article_prompt` already trims, but the key and
        # the recorded title are what `build_row_payload` looks up and then STORES, so a stray
        # space arriving from any other prompt source would put whitespace in a movie title.
        updated["article"][prompt.key.strip()] = str(chosen.get("title") or "").strip()
    return updated
