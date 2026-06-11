"""Vault-backed TMDB-key resolution (T030a) — runtime injection with an env fallback."""

from __future__ import annotations

import logging

from src.secrets import resolve_secret, vault_configured


def test_resolves_from_env_when_vault_unset(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("VAULT_ADDR", raising=False)
    monkeypatch.delenv("VAULT_TOKEN", raising=False)
    monkeypatch.setenv("TMDB_API_KEY", "tmdb-from-env")
    assert resolve_secret("TMDB_API_KEY") == "tmdb-from-env"


def test_missing_everywhere_returns_empty(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    assert resolve_secret("TMDB_API_KEY") == ""


def test_prefers_vault_over_env(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("TMDB_API_KEY", "tmdb-from-env")

    def reader(_path: str) -> dict[str, str]:
        return {"TMDB_API_KEY": "tmdb-from-vault"}

    assert resolve_secret("TMDB_API_KEY", vault_read=reader) == "tmdb-from-vault"


def test_falls_back_to_env_on_vault_error(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("TMDB_API_KEY", "tmdb-from-env")

    def reader(_path: str) -> dict[str, str]:
        raise RuntimeError("vault unreachable")

    assert resolve_secret("TMDB_API_KEY", vault_read=reader) == "tmdb-from-env"


def test_never_logs_the_secret_value(monkeypatch, caplog) -> None:  # type: ignore[no-untyped-def]
    sentinel = "tmdb-super-secret-sentinel"
    monkeypatch.setenv("TMDB_API_KEY", sentinel)

    def reader(_path: str) -> dict[str, str]:
        return {"TMDB_API_KEY": sentinel}

    with caplog.at_level(logging.DEBUG):
        assert resolve_secret("TMDB_API_KEY", vault_read=reader) == sentinel
    assert sentinel not in caplog.text


def test_vault_configured_predicate(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("VAULT_ADDR", "http://v")
    monkeypatch.setenv("VAULT_TOKEN", "t")
    assert vault_configured() is True
    monkeypatch.delenv("VAULT_TOKEN", raising=False)
    assert vault_configured() is False
