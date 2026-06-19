"""Per-run agent-config injection (018 US2 / T021).

Feature 018 makes the assistant bring-your-own-credentials: each run carries the user's own
provider/model/TMDB credentials, supplied by the BFF as the `X-Agent-Config` header. The gateway
captures it (ASGI middleware → ContextVar) and `inject_agent_config` bridges it into
`config["configurable"]["agent_config"]` — exactly like the subject-token bridge, and never
checkpointed (the value carries secrets; SC-004/SC-006). The model-build closures source their
provider/base-URL/key from this per-run config instead of the shared process env.

These pure helpers are unit-tested here; the live ASGI bridge is exercised by the gateway
integration/E2E. Covers:
  - `inject_agent_config` (bridge) + `parse_agent_config` (fail-safe header parse).
  - `runtime_env` (overlay agent_config onto the base env for model selection).
  - `escalation_or_base` (R10: degrade the always-Claude escalation to base without a key).
  - the runtime curator wrapper bridging `config` → the node-task ContextVar the model build reads.
"""

from __future__ import annotations

from typing import Any

from src.agui_identity import inject_agent_config
from src.models import escalation_or_base, runtime_env, select_model_config
from src.runtime_context import get_agent_config, parse_agent_config
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult

# ── inject_agent_config: ContextVar → config["configurable"] bridge ──────────────────────────


def test_inject_agent_config_sets_under_configurable() -> None:
    cfg = {"provider": "ollama", "tmdbKey": "k", "ollamaBaseUrl": "http://h:11434"}
    config: dict[str, Any] = {"configurable": {"thread_id": "t1"}}
    inject_agent_config(config, cfg)
    assert config["configurable"]["agent_config"] == cfg
    assert config["configurable"]["thread_id"] == "t1"  # preserves existing keys


def test_inject_agent_config_creates_configurable_when_absent() -> None:
    config: dict[str, Any] = {}
    inject_agent_config(config, {"provider": "ollama"})
    assert config["configurable"]["agent_config"] == {"provider": "ollama"}


def test_inject_agent_config_is_a_noop_without_config() -> None:
    config: dict[str, Any] = {"configurable": {"thread_id": "t1"}}
    inject_agent_config(config, None)
    assert "agent_config" not in config["configurable"]


# ── parse_agent_config: fail-safe JSON header parse ──────────────────────────────────────────


def test_parse_agent_config_parses_a_json_object() -> None:
    assert parse_agent_config('{"provider":"ollama","tmdbKey":"k"}') == {
        "provider": "ollama",
        "tmdbKey": "k",
    }


def test_parse_agent_config_is_fail_safe() -> None:
    assert parse_agent_config(None) is None
    assert parse_agent_config("") is None
    assert parse_agent_config("not json") is None
    assert parse_agent_config('"a-string"') is None  # JSON, but not an object
    assert parse_agent_config("[1, 2]") is None  # JSON array, not an object


# ── runtime_env: overlay agent_config onto the base env for model selection ──────────────────


def test_runtime_env_overlays_provider_and_keys() -> None:
    base = {"MODEL_PROVIDER": "ollama", "UNRELATED": "x"}
    cfg = {"provider": "anthropic", "anthropicKey": "sk-secret", "ollamaBaseUrl": "http://h:11434"}
    env = runtime_env(cfg, base)
    assert env["MODEL_PROVIDER"] == "anthropic"
    assert env["ANTHROPIC_API_KEY"] == "sk-secret"
    assert env["OLLAMA_BASE_URL"] == "http://h:11434"
    assert env["UNRELATED"] == "x"  # base entries preserved
    assert base["MODEL_PROVIDER"] == "ollama"  # base not mutated


def test_runtime_env_ollama_only_sets_base_url_not_anthropic_key() -> None:
    env = runtime_env({"provider": "ollama", "ollamaBaseUrl": "http://h:11434"}, {})
    assert env["MODEL_PROVIDER"] == "ollama"
    assert env["OLLAMA_BASE_URL"] == "http://h:11434"
    assert "ANTHROPIC_API_KEY" not in env


def test_runtime_env_no_config_returns_base_unchanged() -> None:
    base = {"MODEL_PROVIDER": "ollama"}
    assert runtime_env(None, base) == base


def test_runtime_env_drops_provider_specific_model_pins_on_provider_switch() -> None:
    # 018 review #1: the gateway pins SPECIALIST_MODEL=qwen2.5:32b (an Ollama model id). When a
    # user switches to Anthropic, that pin must be dropped so the Anthropic defaults apply —
    # otherwise ChatAnthropic is built with an Ollama model id and every Claude call 404s.
    base = {
        "MODEL_PROVIDER": "ollama",
        "SUPERVISOR_MODEL": "qwen2.5",
        "SPECIALIST_MODEL": "qwen2.5:32b",
    }
    env = runtime_env({"provider": "anthropic", "anthropicKey": "sk-x"}, base)
    assert env["MODEL_PROVIDER"] == "anthropic"
    assert "SPECIALIST_MODEL" not in env
    assert "SUPERVISOR_MODEL" not in env
    # The Anthropic provider's built-in balanced/fast defaults now apply.
    assert select_model_config("curator", env).model_id == "claude-sonnet-4-6"
    assert select_model_config("supervisor", env).model_id == "claude-haiku-4-5"


def test_runtime_env_keeps_model_pins_when_provider_unchanged() -> None:
    # An Ollama user keeps the gateway's Ollama model pins (no spurious reset).
    base = {"MODEL_PROVIDER": "ollama", "SPECIALIST_MODEL": "qwen2.5:72b"}
    env = runtime_env({"provider": "ollama", "ollamaBaseUrl": "http://h:11434"}, base)
    assert env["SPECIALIST_MODEL"] == "qwen2.5:72b"


def test_runtime_env_drops_shared_anthropic_key_for_an_ollama_only_user() -> None:
    # 018 review #7: a per-user run with no Anthropic key must NEVER inherit the org's shared
    # process-env ANTHROPIC_API_KEY (which the escalation tier would otherwise spend).
    base = {"MODEL_PROVIDER": "ollama", "ANTHROPIC_API_KEY": "sk-shared-org-key"}
    env = runtime_env({"provider": "ollama", "ollamaBaseUrl": "http://h:11434"}, base)
    assert "ANTHROPIC_API_KEY" not in env


def test_resolve_anthropic_key_prefers_the_per_run_user_key_over_vault() -> None:
    # 018 review #4: the per-user key injected into env wins over the shared Vault/static key.
    import src.models as models_mod
    import src.secrets as secrets_mod

    called: dict[str, bool] = {"resolve_secret": False}

    def _fake_resolve_secret(_name: str, _env: Any, **_kw: Any) -> str:
        called["resolve_secret"] = True
        return "VAULT-SHARED-KEY"

    original = secrets_mod.resolve_secret
    secrets_mod.resolve_secret = _fake_resolve_secret  # type: ignore[assignment]
    try:
        assert models_mod.resolve_anthropic_key({"ANTHROPIC_API_KEY": "USER-KEY"}) == "USER-KEY"
        assert called["resolve_secret"] is False  # Vault not consulted when a user key is present
        assert models_mod.resolve_anthropic_key({}) == "VAULT-SHARED-KEY"  # fall back otherwise
        assert called["resolve_secret"] is True
    finally:
        secrets_mod.resolve_secret = original  # type: ignore[assignment]


# ── escalation_or_base: R10 degrade-to-base without an Anthropic key ─────────────────────────


def test_escalation_degrades_to_base_without_an_anthropic_key() -> None:
    # A user who supplied only Ollama must never route to an unusable Claude frontier call.
    spec = escalation_or_base({"MODEL_PROVIDER": "ollama"})
    assert spec.provider == "ollama"
    assert spec == select_model_config("organizer", {"MODEL_PROVIDER": "ollama"})


def test_escalation_uses_claude_when_an_anthropic_key_is_present() -> None:
    spec = escalation_or_base({"ANTHROPIC_API_KEY": "sk-x"})
    assert spec.provider == "anthropic"
    assert spec.model_id == "claude-opus-4-8"


# ── runtime wrapper bridges config["configurable"]["agent_config"] → node-task ContextVar ────


def _minimal_cfg(extract: Any) -> RuntimeNodeConfig:
    async def _call(
        _url: str, _tool: str, _args: dict[str, Any], _token: str | None
    ) -> McpCallResult:
        return McpCallResult(False, None, "")

    return RuntimeNodeConfig(
        web_api_mcp_url="http://web-api-mcp/mcp",
        movie_mcp_url="http://movie-mcp/mcp",
        limiter=AgentToolRateLimiter(max_calls=100, window_seconds=60),
        cache=DownscopedTokenCache(),
        call=_call,
        extract=extract,
    )


async def test_runtime_curator_bridges_agent_config_into_the_contextvar() -> None:
    # The model-build closure reads `get_agent_config()`; the curator wrapper must populate it
    # from the run's `config["configurable"]["agent_config"]` so the build sources per-run creds.
    captured: dict[str, Any] = {}

    def extract_stub(_messages: Any) -> dict[str, Any]:
        captured["cfg"] = get_agent_config()
        return {}  # empty extraction → curator asks "what movie?", no web calls needed

    nodes = build_runtime_nodes(_minimal_cfg(extract_stub))
    agent_config = {"provider": "ollama", "ollamaBaseUrl": "http://h:11434", "tmdbKey": "k"}
    config = {
        "configurable": {"agent_config": agent_config, "user_id": "u", "subject_token": "s"}
    }
    await nodes["curator"]({"messages": [("user", "hi")]}, config)
    assert captured["cfg"] == agent_config


async def test_runtime_curator_resets_the_contextvar_after_the_run() -> None:
    # No cross-run leak: the per-run agent-config is cleared once the node returns.
    nodes = build_runtime_nodes(_minimal_cfg(lambda _m: {}))
    config = {"configurable": {"agent_config": {"provider": "ollama"}, "user_id": "u"}}
    await nodes["curator"]({"messages": [("user", "hi")]}, config)
    assert get_agent_config() is None
