---
type: Convention
title: Model-provider environment scoping
description: Why the agent gateway's LLM provider is env-scoped rather than a single global choice — Ollama for dev/test, Claude for the golden test surface and prod, with escalation always pinned to Claude regardless of the base provider.
tags: [agents, models, ollama, anthropic, environment]
timestamp: 2026-07-26T20:11:56+00:00
---

# Model-provider environment scoping

The [Agent Gateway](../projects/agent-gateway.md) never hardcodes a model provider. Every
graph node resolves its model from `MODEL_PROVIDER` (default `ollama`) plus per-node overrides, via
`select_model_config` in `agents/movie-assistant/src/models.py` — a pure `env -> ModelSpec` function
kept deliberately free of any LLM dependency so it is unit-testable without a live model call.

- **Dev and test default to self-hosted Ollama** (`qwen2.5` fast tier, `qwen2.5:32b` balanced tier) —
  free, local, no API cost for agent-flow iteration.
- **The golden test surface and prod use Anthropic Claude** (`claude-haiku-4-5` fast,
  `claude-sonnet-4-6` balanced) — `MODEL_PROVIDER=anthropic` switches the base provider.
- **The escalation tier is always Claude frontier (`claude-opus-5`), unconditionally** — even when
  the base provider is Ollama. This is a hardcoded exception in `select_model_config`, not an
  env-driven choice: the frontier escape hatch never degrades to a local model.
- **The burst CI surfaces pin a CACHED supervisor, and production deliberately does not**
  (feature 075). `app-e2e` and the dev container set `ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5`;
  `test:golden`, `test:golden-live` and `compose.prod.yaml` pin nothing and take the code defaults.
  The classifier prompt is a ~2,300-token static prefix that repeats on every call, so in a burst
  it caches and a classify costs $0.000516 against $0.001719 uncached on Haiku — 3.3x. A real user
  turn arrives minutes or days apart, never hits the 5-minute entry, and would pay the cache
  *write* instead, so the same change is right for CI and wrong for prod. Pins are
  **provider-scoped** for a reason: see the Gotchas.

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
- **A model id is only a drop-in for the parameters the CALLER sends.** Newer Claude models removed
  the sampling parameters and reject them with a hard 400 — measured 2026-09-21: `claude-sonnet-5`,
  `claude-opus-5` and `claude-opus-4-8` all answer ``temperature is deprecated for this model``,
  while `claude-haiku-4-5`, `claude-sonnet-4-6` and `claude-opus-4-6` accept it. The gateway sent
  `temperature=0.0` unconditionally, so the escalation tier was ALREADY DEAD on `main` and nobody
  knew: it is flag-gated off, so nothing ever called it. `anthropic_accepts_temperature` in
  `models.py` now gates the parameter, and **an unrecognised id OMITS it** — omitting never fails,
  sending can. `tests/integration/test_model_invocability.py` calls every resolvable id once so a
  future deprecation fails a test instead of production.
- **Losing `temperature` costs DETERMINISM, and that decides which tiers may move.** With no
  `temperature=0` to pin, free-form JSON extraction picks up sampling variance: three runs of one
  input on Sonnet 5 gave `Inception`, `{}`, `{}`, where Sonnet 4.6 gave `Inception` 3/3. A
  one-word intent label does not suffer this (6 probes x 3 runs: 0 wrong, 0 flaky). That is why
  feature 075 moved the supervisor to a newer model and **withdrew** the same move for the
  specialists — the extraction tier feeds the write-proposal path behind the HITL gate, where a
  silently dropped field becomes a wrong proposal. Revisit with structured outputs, not an id swap.
- **A model pin must name its provider.** `ANTHROPIC_SUPERVISOR_MODEL` is read only when that
  provider is active; the bare `SUPERVISOR_MODEL` follows whichever provider is. `app-ci.yml`
  offers `provider: choice [anthropic, ollama]`, so a bare pin at job scope resolves to
  `ModelSpec(provider='ollama', model_id='claude-sonnet-5')` on an Ollama run — a Claude id sent to
  Ollama. `_pin` in `models.py` resolves `<PROVIDER>_<NAME>` ahead of the bare name for exactly
  this. (`runtime_env` pops only the BARE names on a per-user provider switch, and deliberately so:
  scoped names are already inert on the wrong provider.)

See [Testing tiers](./testing-tiers.md) for how the golden suite consumes this
scoping, and `CLAUDE.md`'s "AI Agent Layer" section plus `docs/runbooks/agent-layer.md` for the full
per-node model configuration reference.
