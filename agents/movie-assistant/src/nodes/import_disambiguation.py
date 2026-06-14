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
            if not raw or raw in resolved_article or raw in seen_titles:
                continue
            norm = normalize_title_article(raw)
            if norm.needs_confirm:
                seen_titles.add(raw)
                article_prompts.append(_article_prompt(raw))

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
    options = [{"id": "keep", "title": raw_title}]
    reordered = _reorder_trailing(raw_title)
    if reordered and reordered != raw_title:
        options.append({"id": "reorder", "title": reordered})
    return ImportPrompt(
        kind="article",
        key=raw_title,
        question=f'How should "{raw_title}" be sorted?',
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
        updated["article"][prompt.key] = str(chosen.get("title"))
    return updated
