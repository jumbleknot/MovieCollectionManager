"""Unit tests for per-agent MCP tool allowlists (T018).

Least privilege (constitution §Per-Agent Tool Allowlists): access is by configuration,
deny-by-default. Curator is read-only; organizer reads + writes; supervisor calls no
domain tools. Enforced here as pure logic (no MCP client / network needed to test).
"""

import pytest

from src.tools.mcp_tools import is_tool_allowed


@pytest.mark.parametrize(
    "read_tool",
    [
        "get_collection",
        "list_movies",
        "count_movies",
        "list_collections",
        "search_title",
        "get_movie_details",
    ],
)
def test_curator_may_call_read_tools(read_tool):
    assert is_tool_allowed("curator", read_tool) is True


def test_query_agent_is_read_only():
    # US4 (T071): the query agent answers collection questions — reads only, never writes.
    assert is_tool_allowed("query", "count_movies") is True
    assert is_tool_allowed("query", "list_movies") is True
    assert is_tool_allowed("query", "list_collections") is True
    assert is_tool_allowed("query", "add_movie") is False
    assert is_tool_allowed("query", "delete_movie") is False
    assert is_tool_allowed("query", "create_collection") is False


def test_search_agent_is_read_only():
    # US7 (T066): the search workflow reads owned collections/movies + web search_title — never
    # writes (a web add routes through the curator/organizer approval flow, not the search agent).
    assert is_tool_allowed("search", "list_collections") is True
    assert is_tool_allowed("search", "list_movies") is True
    assert is_tool_allowed("search", "search_title") is True
    assert is_tool_allowed("search", "add_movie") is False
    assert is_tool_allowed("search", "delete_movie") is False
    assert is_tool_allowed("search", "create_collection") is False


@pytest.mark.parametrize(
    "write_tool", ["add_movie", "update_movie", "delete_movie", "create_collection"]
)
def test_curator_may_not_call_write_tools(write_tool):
    assert is_tool_allowed("curator", write_tool) is False


def test_organizer_may_call_reads_and_writes():
    assert is_tool_allowed("organizer", "list_movies") is True
    assert is_tool_allowed("organizer", "add_movie") is True
    assert is_tool_allowed("organizer", "delete_movie") is True


def test_supervisor_may_call_no_domain_tools():
    assert is_tool_allowed("supervisor", "get_collection") is False
    assert is_tool_allowed("supervisor", "add_movie") is False


def test_import_node_allowlist():
    # 014 US2: import reads collections/movies + parses + HITL-gated create/update. No delete.
    assert is_tool_allowed("import_collection", "list_collections") is True
    assert is_tool_allowed("import_collection", "list_movies") is True
    assert is_tool_allowed("import_collection", "parse_spreadsheet") is True
    assert is_tool_allowed("import_collection", "add_movie") is True
    assert is_tool_allowed("import_collection", "update_movie") is True
    assert is_tool_allowed("import_collection", "delete_movie") is False
    assert is_tool_allowed("import_collection", "build_workbook") is False


def test_export_node_allowlist():
    # 014 US3: export reads collections/movies + builds the workbook. No domain writes.
    assert is_tool_allowed("export_collection", "list_collections") is True
    assert is_tool_allowed("export_collection", "list_movies") is True
    assert is_tool_allowed("export_collection", "build_workbook") is True
    assert is_tool_allowed("export_collection", "add_movie") is False
    assert is_tool_allowed("export_collection", "update_movie") is False
    assert is_tool_allowed("export_collection", "parse_spreadsheet") is False


def test_unknown_tool_denied_by_default():
    assert is_tool_allowed("organizer", "drop_database") is False


def test_unknown_agent_denied_by_default():
    assert is_tool_allowed("rogue-agent", "get_collection") is False


# ── 047 US4 (T067): get_movie_metadata is the ORGANIZER's alone ──────────────────────────────
#
# The organizer calls it when building the media-format and rip-quality multi-selects. No other
# agent has a reason to, so no other agent gets it — least privilege, asserted rather than
# assumed (constitution §Per-Agent Tool Allowlists).
#
# NOTE ON THE CONTRACT WORDING: contracts/movie-metadata.md §3 says to add the tool to
# `_READ_TOOLS` *and* to the organizer's allowlist. Those two instructions contradict each
# other in this codebase — `_READ_TOOLS` is not a classification used anywhere else, it is
# literally the set granted to curator, navigator, query and search as well, so adding it there
# would hand the tool to four agents that must not have it. The deny half of this test is the
# requirement that survives.


def test_organizer_may_call_get_movie_metadata():
    assert is_tool_allowed("organizer", "get_movie_metadata") is True


@pytest.mark.parametrize(
    "agent",
    [
        "supervisor",
        "curator",
        "navigator",
        "query",
        "search",
        "import_collection",
        "export_collection",
        "rogue-agent",
    ],
)
def test_only_the_organizer_may_call_get_movie_metadata(agent):
    assert is_tool_allowed(agent, "get_movie_metadata") is False


def test_get_movie_metadata_grant_did_not_widen_the_shared_read_set():
    """Granting the organizer a tool must not quietly grant it to every read agent.

    Pins the blast radius of the change itself: if a later edit moves the tool into the
    shared read set for convenience, this fails instead of silently widening four allowlists.
    """
    for agent in ("curator", "navigator", "query", "search"):
        assert is_tool_allowed(agent, "list_movies") is True, f"{agent} lost its normal reads"
        assert is_tool_allowed(agent, "get_movie_metadata") is False
