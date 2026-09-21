# Quickstart: validating LLM cost reduction, phase 1

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-09-20

How to prove this feature works, cheapest check first. Every command below runs from
the repository root unless stated. Commands are grouped by what they cost: the first
group spends nothing, the second spends real money, and the third takes ~35 minutes of
CI.

> **Worktree note.** Another agent may be live in this dev container. Run these from
> your own worktree, and remember that an `nx` target in a fresh worktree needs a real
> `CI=true pnpm install --frozen-lockfile` inside it — a `node_modules` symlink covers
> `node --test` and the plain scripts, but not `pnpm nx`.

---

## 1. Free and offline — run these on every edit

### 1a. The generator guard (US1, FR-002/003/004)

Keyless, makes no model call, and must pass **without modification**. If it fails, the
model id is wrong — do not relax the guard (FR-004).

```bash
node --test scripts/__tests__/wiki-maintain.guard.test.mjs
```

Expect 4 passing. Two assertions are unconditional (an explicit output cap is set, at
or above 16,384; the reason for it is recorded in the target description). Two more
resolve the pinned id through openwiki's own resolver and through the LangChain table —
both already carry `claude-sonnet-5` (research R6), so neither should skip here.

> **Instrument check**: those last two `t.skip(...)` when openwiki is not installed at
> `/usr/local/lib/node_modules/openwiki`. A skip reads as a pass. Confirm the output
> says 4 passed, not 2 passed / 2 skipped, before believing this gate.

### 1b. Prefix byte-stability (US2, FR-006)

The cheapest guard on the whole saving: it proves the static block interpolates nothing.

```bash
pnpm nx test movie-assistant
```

The new `tests/unit/test_supervisor_prompt_cache.py` builds the classification messages
twice with *different* user text and asserts the system block is byte-identical, and
that it carries `cache_control: {"type": "ephemeral"}`.

**Verify RED before implementing**: while `classify_intent` still returns one string,
there is no system block to assert on — the test errors. A RED showing 0 failures means
the test is trivially passing and must be corrected.

### 1c. The model-selection contract (US3, FR-013)

`select_model_config` is pure, so the whole contract table is checkable with no key:

```bash
pnpm nx test movie-assistant
```

Covers: production resolves the fast tier for both supervisor and specialist; a
`SUPERVISOR_MODEL` pin resolves the cached tier; escalation still forces Anthropic
regardless of base provider; a BYOK provider switch still drops all three per-node pins.

### 1d. The keyless merge gate (FR-018)

```bash
pnpm nx test:golden movie-assistant
```

Replay, no credential. **Before re-recording this will fail loudly** with
`CassetteMissError` on every pair — that is the intended signal that the prompt shape
and specialist id changed, not a defect. After re-recording (§2a) it must be fully
green, and it must still need no key.

---

## 2. Costs real money — budget these deliberately

### 2a. Re-record the cassettes (FR-017)

43 files. Requires `MCM_ANTHROPIC_API_KEY` in the dev container (mapped to
`ANTHROPIC_API_KEY` only at the point of use — never export `ANTHROPIC_API_KEY` into
your shell, or Claude Code silently bills per-token against the subscription).

```bash
ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  LLM_CASSETTE_MODE=record pnpm nx test:golden movie-assistant
```

Then re-run §1d in replay and confirm green.

**The one that is easy to miss**: `topic-confinement.qwen2-5.json` is keyed to `qwen2.5`
and an Anthropic key cannot regenerate it. It needs a local Ollama serving `qwen2.5`:

```bash
ollama serve &                 # if not already running
ollama pull qwen2.5
MODEL_PROVIDER=ollama LLM_CASSETTE_MODE=record \
  uv run pytest tests/integration/test_out_of_domain.py   # from agents/movie-assistant
```

Skipping this leaves a `CassetteMissError` in a suite nobody associates with an
Anthropic change (research R5/R9). Re-running the Ollama tier afterwards is also the
only evidence that `qwen2.5` did not regress on the new message shape.

### 2b. Caching actually engages (US2, FR-009/010/011 — the headline check)

```bash
cd agents/movie-assistant
ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  MODEL_PROVIDER=anthropic \
  SUPERVISOR_MODEL=claude-sonnet-5 \
  MCM_REQUIRE_LIVE_MODEL=1 \
  uv run pytest tests/integration/test_prompt_cache_effectiveness.py -v
```

Two classifications back to back; the second must report
`usage_metadata["input_token_details"]["cache_read"] > 0`.

Three ways this fails, and what each means:

| Result | Means |
|---|---|
| `cache_read == 0` on the second call | **Prefix drift** — something in the static block varies per call. This is the failure the feature exists to detect. |
| Fails naming a missing credential | Correct behaviour under `MCM_REQUIRE_LIVE_MODEL=1` (FR-010). A skip here would certify a saving never measured. |
| Fails naming provider capacity | Infrastructure, not caching. Re-run; do not investigate as a prompt regression. |

> **Instrument check**: drop `MCM_REQUIRE_LIVE_MODEL=1` and the same missing credential
> becomes a **skip**, and the run reports exit 0. Always watch the skip count.

### 2c. The pre-deploy gate still certifies production (research R3)

```bash
ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" pnpm nx test:golden-live movie-assistant
```

This target sets `MODEL_PROVIDER=anthropic`, `MCM_REQUIRE_LIVE_MODEL=1` and **no**
per-node pin, so it runs the code defaults — which are production's configuration.
Do **not** add a `SUPERVISOR_MODEL` pin to this target: it would make the gate certify
a model production does not run.

---

## 3. Full regression — before opening merge 2

```bash
pnpm nx affected -t lint test
pnpm nx e2e mcm-app-e2e            # in the official Playwright image; ~35 min
```

Derive the tiers from what the diff touched, not from memory — the Python lint tier in
particular is easy to skip when only `test` was run.

---

## 4. Confirming the saving landed

The repository now defends the *mechanism* (§1b, §2b). The *amount* is still read from
the vendor's billing export, a day or more after merge:

| Surface | Expect |
|---|---|
| CI e2e key | Non-zero `input_cache_read` rows where there were none, and the fast-tier input line falling from ~$22/30d toward ~$3–5 |
| Generator key | Cost per run-day ≈$1.15, down from ≈$1.72, with no rise in zero-page runs |
| Any BYOK key | ≈$0.0035 per turn, down from ≈$0.005 |

If the CI key shows no cache-read rows a day after merge, §2b passed and reality
disagrees — check that the job actually sets **both** variable names (see
[contracts/model-selection.md](./contracts/model-selection.md)), because the container
and the in-job pytest process read different ones.

---

## Rollback

Each merge reverts independently.

- **Merge 1**: restore the previous `OPENWIKI_MODEL_ID`. No fixtures, no code.
- **Merge 2**: reverting restores the previous defaults *and* the previous prompt shape,
  which restores the previous cassette keys — so the committed cassettes from before
  the revert are the ones that match. Revert the cassette files together with the code;
  reverting code alone leaves a full suite of misses.
