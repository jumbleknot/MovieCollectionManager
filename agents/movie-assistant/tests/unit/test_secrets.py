"""Vault-backed secret resolution (T030a) — runtime injection with an env fallback.

Deployed environments inject LLM/MCP credentials from HashiCorp Vault; local dev falls back to
`.env.local`. The resolver NEVER logs a secret value (SC-004) and NEVER crashes the run on a
Vault error — it falls back to the environment.
"""

from __future__ import annotations

from src.secrets import resolve_secret, vault_configured


def test_resolves_from_env_when_vault_unset() -> None:
    env = {"ANTHROPIC_API_KEY": "sk-from-env"}
    assert resolve_secret("ANTHROPIC_API_KEY", env) == "sk-from-env"


def test_missing_everywhere_returns_none() -> None:
    assert resolve_secret("NOPE", {}) is None


def test_prefers_vault_over_env_when_reader_present() -> None:
    env = {"ANTHROPIC_API_KEY": "sk-from-env", "VAULT_ADDR": "http://v", "VAULT_TOKEN": "t"}

    def reader(_path: str) -> dict[str, str]:
        return {"ANTHROPIC_API_KEY": "sk-from-vault"}

    assert resolve_secret("ANTHROPIC_API_KEY", env, vault_read=reader) == "sk-from-vault"


def test_falls_back_to_env_when_vault_lacks_the_key() -> None:
    env = {"TMDB_API_KEY": "tmdb-env", "VAULT_ADDR": "http://v", "VAULT_TOKEN": "t"}

    def reader(_path: str) -> dict[str, str]:
        return {"OTHER": "x"}  # the requested key isn't in Vault

    assert resolve_secret("TMDB_API_KEY", env, vault_read=reader) == "tmdb-env"


def test_falls_back_to_env_on_vault_error() -> None:
    env = {"TMDB_API_KEY": "tmdb-env", "VAULT_ADDR": "http://v", "VAULT_TOKEN": "t"}

    def reader(_path: str) -> dict[str, str]:
        raise RuntimeError("vault unreachable")

    # A Vault failure must NOT crash the run — fall back to the environment.
    assert resolve_secret("TMDB_API_KEY", env, vault_read=reader) == "tmdb-env"


def test_never_logs_the_secret_value(caplog: object) -> None:
    sentinel = "sk-super-secret-sentinel-value"
    env = {"ANTHROPIC_API_KEY": sentinel, "VAULT_ADDR": "http://v", "VAULT_TOKEN": "t"}

    def reader(_path: str) -> dict[str, str]:
        return {"ANTHROPIC_API_KEY": sentinel}

    import logging as _logging

    with caplog.at_level(_logging.DEBUG):  # type: ignore[attr-defined]
        assert resolve_secret("ANTHROPIC_API_KEY", env, vault_read=reader) == sentinel
    assert sentinel not in caplog.text  # type: ignore[attr-defined]


def test_vault_configured_predicate() -> None:
    assert vault_configured({"VAULT_ADDR": "http://v", "VAULT_TOKEN": "t"}) is True
    assert vault_configured({"VAULT_ADDR": "http://v"}) is False  # token missing
    assert vault_configured({}) is False
