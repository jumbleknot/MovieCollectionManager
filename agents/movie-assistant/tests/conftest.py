"""Shared pytest fixtures for movie-assistant tests.

Unit tests (tests/unit) may mock tools. Integration tests (tests/integration) MUST run
against real movie-mcp + real mc-service (constitution §Test Type Integrity); only the
LLM provider may be cassette/replayed for determinism (T032).
"""
