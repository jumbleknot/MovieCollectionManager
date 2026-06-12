"""Article-insensitive title matching (013 US8, FR-032/033).

Pure, deterministic helpers shared by the search/navigate owned-movie matching so a user's
query matches a stored title regardless of a leading article (a/an/the) on either side — fixing
Bug 3, where "secret of nimh" failed to match the stored "The Secret of NIMH". Mirrors the
mc-service `title_sort_key` normalization (013 US9) on the agent side. No LLM → no golden churn.

Only a *leading* article is stripped (case-insensitive); an article-prefixed word with no
following space ("Theremin", "Anaconda") is left intact, matching the mc-service rule.
"""

from __future__ import annotations

import re

# A single leading a/an/the + following whitespace. Anchored; counts only the first occurrence.
_LEADING_ARTICLE_RE = re.compile(r"^(?:a|an|the)\s+", re.IGNORECASE)


def strip_leading_article(text: str) -> str:
    """Remove a single leading `a`/`an`/`the` (+ following whitespace), case-insensitive."""
    return _LEADING_ARTICLE_RE.sub("", (text or "").strip(), count=1)


def normalize_title(text: str) -> str:
    """The comparison key for article-insensitive title matching: stripped + lowercased."""
    return strip_leading_article(text).casefold().strip()


def titles_match(query: str, stored: str) -> bool:
    """Whether `query` names `stored`, article-insensitively.

    True when the normalized forms are equal or one contains the other (so "secret of nimh"
    matches "The Secret of NIMH" and vice-versa). Empty/whitespace either side → False so a
    blank query can't match everything.
    """
    q = normalize_title(query)
    s = normalize_title(stored)
    if not q or not s:
        return False
    return q == s or q in s or s in q
