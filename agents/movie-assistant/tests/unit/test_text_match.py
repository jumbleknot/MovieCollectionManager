"""013 US8 (FR-032/033): article-insensitive title matching helpers.

Fixes Bug 3 — "secret of nimh" must match the stored "The Secret of NIMH" with or without a
leading article, on either side, and a leading article must NOT be injected. Pure functions.
"""

from src.text_match import normalize_title, strip_leading_article, titles_match


class TestStripLeadingArticle:
    def test_strips_each_article_case_insensitive(self):
        assert strip_leading_article("The Matrix") == "Matrix"
        assert strip_leading_article("THE Secret of NIMH") == "Secret of NIMH"
        assert strip_leading_article("a Quiet Place") == "Quiet Place"
        assert strip_leading_article("An Education") == "Education"

    def test_leaves_non_article_prefixed_words_intact(self):
        # an article-prefixed word with no following space is NOT an article
        assert strip_leading_article("Theremin") == "Theremin"
        assert strip_leading_article("Anaconda") == "Anaconda"
        assert strip_leading_article("Apollo 13") == "Apollo 13"

    def test_only_one_leading_article_removed(self):
        assert strip_leading_article("The A Team") == "A Team"


class TestTitlesMatch:
    def test_matches_regardless_of_leading_article_either_side(self):
        # Bug 3: query lacks the article, stored has it
        assert titles_match("secret of nimh", "The Secret of NIMH")
        # reverse: query has the article, stored lacks it
        assert titles_match("The Secret of NIMH", "secret of nimh")
        # both lack / both have
        assert titles_match("Matrix", "the matrix")
        assert titles_match("The Matrix", "The Matrix")

    def test_substring_match_after_normalization(self):
        assert titles_match("nimh", "The Secret of NIMH")

    def test_distinct_titles_do_not_match(self):
        assert not titles_match("Avatar", "The Matrix")

    def test_blank_query_matches_nothing(self):
        assert not titles_match("", "The Matrix")
        assert not titles_match("the", "The Matrix")  # bare "the" (no space) ≠ "matrix"


class TestNormalizeTitle:
    def test_lowercases_and_strips_article(self):
        assert normalize_title("The Matrix") == "matrix"
        assert normalize_title("  An   Education  ") == "education"
