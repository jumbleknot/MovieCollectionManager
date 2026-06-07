"""Unit tests for per-agent MCP tool allowlists (T018).

Least privilege (constitution §Per-Agent Tool Allowlists): access is by configuration,
deny-by-default. Curator is read-only; organizer reads + writes; supervisor calls no
domain tools. Enforced here as pure logic (no MCP client / network needed to test).
"""

import pytest

from src.tools.mcp_tools import is_tool_allowed


@pytest.mark.parametrize(
    "read_tool",
    ["get_collection", "list_movies", "list_collections", "search_title", "get_movie_details"],
)
def test_curator_may_call_read_tools(read_tool):
    assert is_tool_allowed("curator", read_tool) is True


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


def test_unknown_tool_denied_by_default():
    assert is_tool_allowed("organizer", "drop_database") is False


def test_unknown_agent_denied_by_default():
    assert is_tool_allowed("rogue-agent", "get_collection") is False
