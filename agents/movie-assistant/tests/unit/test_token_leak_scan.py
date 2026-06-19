"""SC-004 / FR-016 token-leak scan (T031) — the automated quality-gate scan.

Three complementary checks prove "no user authentication token is ever in conversation state,
memory, traces, or logs":
1. **Static** — `scan_paths` flags any `logging`/`print` call that emits a token-named variable
   across the whole agent + MCP source (catches a regression on ANY log site).
2. **Runtime** — drive the real downscoped-token path with sentinel tokens and assert neither
   reaches the logs.
3. **Checkpoint invariant** — `forbid_token_fields` rejects a token-named field and `GraphState`
   declares none (no token ever persisted).

The scanner itself is also tested positively (it must DETECT a planted leak) and negatively (a
token *word* in a message literal is not a finding) — a scan that always passes is worthless.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from src.eval.token_leak_scan import scan_paths, scan_source_text
from src.state import forbid_token_fields
from src.tools.identity import DownscopedTokenCache, acquire_downscoped_token
from src.tools.token_exchange import ExchangedToken

# Runs in the normal unit gate (`pnpm nx test movie-assistant`, hence CI — T064); the marker
# also lets it run in isolation: `pnpm nx test movie-assistant -- -m leak_scan`.
pytestmark = pytest.mark.leak_scan

# repo root: .../agents/movie-assistant/tests/unit/test_token_leak_scan.py → up 4
_REPO_ROOT = Path(__file__).resolve().parents[4]
_SCANNED_SRC = [
    _REPO_ROOT / "agents" / "movie-assistant" / "src",
    _REPO_ROOT / "mcp-servers" / "movie-mcp" / "src",
    _REPO_ROOT / "mcp-servers" / "web-api-mcp" / "src",
]


# ── Static scan: no token-named variable is logged anywhere in the agent + MCP source ──


def test_no_token_variable_is_logged_in_agent_or_mcp_source() -> None:
    # Guard against a false-green: the roots must resolve + actually contain source, else the
    # scan would silently examine nothing and pass.
    assert all(root.exists() for root in _SCANNED_SRC), f"scan roots missing: {_SCANNED_SRC}"
    scanned = [py for root in _SCANNED_SRC for py in root.rglob("*.py")]
    assert len(scanned) >= 20, f"expected agent + MCP source scanned, found {len(scanned)}"
    findings = scan_paths(_SCANNED_SRC)
    assert findings == [], "SC-004 token-leak: a token-named variable is logged:\n" + "\n".join(
        f"  {f.file}:{f.line} {f.call} logs {f.identifier!r}" for f in findings
    )


# ── The scanner must actually DETECT leaks ──


def test_scanner_flags_a_logged_token_variable() -> None:
    src = "import logging\nlog = logging.getLogger(__name__)\nlog.info(subject_token)\n"
    leaks = scan_source_text(src)
    assert [f.identifier for f in leaks] == ["subject_token"]
    assert leaks[0].call == ".info()"


def test_scanner_flags_an_fstring_token_leak() -> None:
    leaks = scan_source_text('logger.error(f"exchanged={exchanged_token}")')
    assert leaks and leaks[0].identifier == "exchanged_token"


def test_scanner_flags_a_printed_authorization_attribute() -> None:
    leaks = scan_source_text("print(request.authorization)")
    assert leaks and leaks[0].identifier == "authorization" and leaks[0].call == "print"


def test_scanner_flags_a_logged_agent_config() -> None:
    # 018 US2 (T022): the per-run agent config carries decrypted provider + TMDB keys, so a
    # planted `logger.info(agent_config)` must be flagged just like a token.
    leaks = scan_source_text("logger.info(agent_config)")
    assert leaks and leaks[0].identifier == "agent_config"


def test_scanner_flags_logged_anthropic_and_tmdb_keys() -> None:
    leaks = scan_source_text('logger.error(f"{anthropic_api_key} {tmdb_api_key}")')
    ids = {f.identifier for f in leaks}
    assert "anthropic_api_key" in ids
    assert "tmdb_api_key" in ids


# ── ...but does NOT false-positive on a token *word* in a message literal / non-log call ──


def test_scanner_ignores_token_word_in_a_message_literal() -> None:
    src = 'logger.error("token re-exchange failed: status=%s", status_code)'
    assert scan_source_text(src) == []


def test_scanner_ignores_passing_a_token_to_a_non_log_call() -> None:
    assert scan_source_text("make_mc_client(subject_token)") == []


# ── Runtime sentinel: the real downscoped-token acquisition emits no token to logs ──


async def test_acquire_downscoped_token_logs_no_token(caplog: pytest.LogCaptureFixture) -> None:
    sentinel_subject = "SENTINEL-SUBJECT-zzz999"
    sentinel_exchanged = "SENTINEL-EXCHANGED-zzz999"

    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(_subject: str) -> ExchangedToken:
        return ExchangedToken(token=sentinel_exchanged, expires_in=60)

    with caplog.at_level(logging.DEBUG):
        out = await acquire_downscoped_token(
            sentinel_subject,
            user_id="kc-uuid",
            authorize=authorize,
            exchange=exchange,
            cache=DownscopedTokenCache(),
        )

    assert out == sentinel_exchanged  # returned out-of-band to the tool path, never logged
    log_blob = "\n".join(record.getMessage() for record in caplog.records)
    assert sentinel_subject not in log_blob
    assert sentinel_exchanged not in log_blob


# ── Checkpoint invariant: no token-named field is ever persisted to GraphState (SC-004) ──


def test_checkpointed_state_rejects_token_fields() -> None:
    forbid_token_fields({"thread_id": "t1", "user_id": "u", "messages": []})  # clean → no raise
    for bad in ("subject_token", "downscoped_token", "authorization", "bearer_token", "secret"):
        with pytest.raises(ValueError):
            forbid_token_fields({bad: "leak-value"})


def test_checkpointed_state_rejects_018_credential_fields() -> None:
    # 018 US2 (T022): the per-run config + its decrypted keys must never become a state field.
    for bad in ("agent_config", "anthropic_api_key", "tmdb_api_key"):
        with pytest.raises(ValueError):
            forbid_token_fields({bad: "leak-value"})


def test_graph_state_declares_no_token_field() -> None:
    from src.graph import GraphState

    markers = ("token", "jwt", "authorization", "bearer", "secret", "credential")
    leaked = [
        field
        for field in getattr(GraphState, "__annotations__", {})
        if any(marker in field.lower() for marker in markers)
    ]
    assert leaked == [], f"GraphState declares a token-named field (SC-004): {leaked}"
