---
type: Convention
title: Model-provider environment scoping
description: Why the agent gateway's LLM provider is env-scoped rather than a single global choice — Ollama for dev/test, Claude for the golden test surface and prod, with escalation always pinned to Claude regardless of the base provider.
resource: CLAUDE.md
tags: [agents, models, ollama, anthropic, environment]
timestamp: 2026-07-26T20:11:56+00:00
---

# Model-provider environment scoping

The [Agent Gateway](/openwiki/projects/agent-gateway.md) never hardcodes a model provider. Every
graph node resolves its model from `MODEL_PROVIDER` (default `ollama`) plus per-node overrides, via
`select_model_config` in `agents/movie-assistant/src/models.py` — a pure `env -> ModelSpec` function
kept deliberately free of any LLM dependency so it is unit-testable without a live model call.

- **Dev and test default to self-hosted Ollama** (`qwen2.5` fast tier, `qwen2.5:32b` balanced tier) —
  free, local, no API cost for agent-flow iteration.
- **The golden test surface and prod use Anthropic Claude** (`claude-haiku-4-5` fast,
  `claude-sonnet-4-6` balanced) — `MODEL_PROVIDER=anthropic` switches the base provider.
- **The escalation tier is always Claude frontier (`claude-opus-4-8`), unconditionally** — even when
  the base provider is Ollama. This is a hardcoded exception in `select_model_config`, not an
  env-driven choice: the frontier escape hatch never degrades to a local model.

## Gotchas

- **This is the one rule that keeps golden-cassette recordings stable.** Golden fixtures are recorded
  against Claude; because the escalation tier is provider-pinned rather than env-following, a switch
  to local Ollama for routine dev iteration cannot silently change escalation behavior underneath a
  recorded cassette.
- **Per-run agent config overlays the base env, not the other way around.** `runtime_env()` maps a
  per-user `ResolvedRunConfig` (provider / Ollama base URL / Anthropic key) onto the same env keys
  `select_model_config` reads — so a per-user override changes model selection without touching
  `os.environ` or the pure selection function's signature. No agent config present → behavior is
  byte-for-byte the shared-env default.
- **Rebuild the gateway/MCP images after any agent-source change.** A stale image silently keeps
  running old model-selection or node logic — this bites during local iteration because Docker will
  happily reuse a cached layer.
- **The dev-container path runs a local Ollama, not a remote one.** `MODEL_PROVIDER=ollama` (the
  default) resolves against an in-container `dev-ollama` service; the historical "Ollama unreachable
  from nested Docker" failure mode is fixed by running Ollama *inside* the dev container rather than
  reaching out to it, at zero cost to the gateway's existing configuration.
- **`MODEL_PROVIDER=anthropic` is the deliberate fallback path for the golden/Claude-surface**, used
  when validating behavior that must match golden cassettes, not merely a "better model" toggle.

See [Testing tiers](/openwiki/invariants/testing-tiers.md) for how the golden suite consumes this
scoping, and `CLAUDE.md`'s "AI Agent Layer" section plus `docs/runbooks/agent-layer.md` for the full
per-node model configuration reference.
