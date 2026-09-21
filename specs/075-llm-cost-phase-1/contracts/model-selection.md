# Contract: model selection per surface

**Feature**: [../spec.md](../spec.md) · **Research**: [../research.md](../research.md) R3/R4/R8

The agent gateway exposes no new API in this feature. Its one externally-bound
interface is the **environment contract**: which variables each surface sets, and which
model each graph node therefore resolves to. This file is that contract. It is the
thing other surfaces (workflows, compose files, the dev container, a developer's
shell) bind to, and the thing that breaks if a variable is set in the wrong place or
under the wrong name.

---

## The contract

`select_model_config(node, env)` is pure. For a given node it resolves, in order:

1. the per-node override variable, if non-empty;
2. otherwise the provider's entry in the defaults table for that node's tier.

| Node | Override variable | Tier table |
|---|---|---|
| `supervisor` | `SUPERVISOR_MODEL` | fast |
| `curator`, `organizer`, `query` | `SPECIALIST_MODEL` | balanced |
| `escalation` | `ESCALATION_MODEL` | always Anthropic frontier, regardless of base provider |

`MODEL_PROVIDER` selects the table column; unset means `ollama`.

---

## Per-surface bindings after this feature

| Surface | `MODEL_PROVIDER` | Supervisor | Specialist | Set where | Why |
|---|---|---|---|---|---|
| **Production** | `anthropic` | *code default* — fast tier | *code default* — fast tier | `compose.prod.yaml` pins **neither** | A lone user turn never reaches the cache; the cached tier would cost ≈2.5× more (R8). Pinning nothing is deliberate and is what ships the extraction saving to BYOK users automatically. |
| **`app-e2e` gateway container** | `anthropic` | **cached tier** | *code default* | `ANTHROPIC_SUPERVISOR_MODEL` in the `app-e2e` job env | Where the $22 actually is: ~29M uncached classification tokens/month in back-to-back bursts, hit rate ≥95%. |
| **`app-e2e` in-job live tests** (`-m "not golden"`) | `anthropic` | **cached tier** | *code default* | the **same** `ANTHROPIC_SUPERVISOR_MODEL` — see the naming rule below | Same burst. Reads the provider-scoped name directly once `select_model_config` honours it (R12); a bare `SUPERVISOR_MODEL` here would break the `provider: ollama` dispatch. |
| **`app-e2e` dispatched with `provider: ollama`** | `ollama` | `qwen2.5` | `qwen2.5:32b` | nothing — the Anthropic-scoped pins are inert | **This path must keep working.** `app-ci.yml` offers `provider: choice [anthropic, ollama]`, so the job genuinely runs both ways (R12). |
| **`test:golden`** (merge gate, replay) | `anthropic` | *code default* | *code default* | nothing — replay, keyless | Cassettes are keyed by model id; a pin here would miss all 31 committed supervisor cassettes (R3). |
| **`test:golden-live`** (pre-deploy gate) | `anthropic` | *code default* | *code default* | target sets only `MODEL_PROVIDER` + `MCM_REQUIRE_LIVE_MODEL` | A deploy gate must certify **what deploys**. Production runs the code defaults, so the gate must too (R3 — this corrects the proposal). |
| **Dev container** | per developer | **cached tier** when Anthropic | *code default* | `ANTHROPIC_SUPERVISOR_MODEL` in `devcontainer.json` | Same burst shape as CI; same saving. |
| **Local Ollama default** | `ollama` (unset) | `SUPERVISOR_MODEL` or `qwen2.5` | `SPECIALIST_MODEL` or `qwen2.5:32b` | `scripts/agent-stack.mjs` | Unchanged by this feature. |
| **DAST job** | `anthropic` | — | — | key exists only so the gateway boots | Zero inference; unchanged. |

---

## Naming rule — provider-scoped pins, and why a bare one is unsafe

**A pin must name the provider it is for.** `scripts/agent-stack.mjs` already works this
way, and after R12 `select_model_config` does too, so the rule holds on every surface
rather than only inside one Node script:

- **`SUPERVISOR_MODEL` / `SPECIALIST_MODEL`** are the *bare* names. They follow whatever
  provider is active — including Ollama, where they default to `qwen2.5` /
  `qwen2.5:32b`. Setting either to an Anthropic id at job scope sends that id to
  whichever provider the job happens to run.
- **`ANTHROPIC_SUPERVISOR_MODEL` / `ANTHROPIC_SPECIALIST_MODEL`** are read **only** on
  the Anthropic path, and are inert everywhere else.

So the `app-e2e` job pins one name, the provider-scoped one:

```yaml
# app-e2e job env
ANTHROPIC_SUPERVISOR_MODEL: claude-sonnet-5   # gateway container AND in-job pytest
```

**Why not the bare name.** `app-ci.yml` declares
`provider: choice [anthropic, ollama]` and the job reads
`MODEL_PROVIDER: ${{ github.event.inputs.provider || vars.MODEL_PROVIDER || 'anthropic' }}`,
so this job really does run both ways. Measured (R12):

```
MODEL_PROVIDER=ollama + SUPERVISOR_MODEL=claude-sonnet-5
  → ModelSpec(provider='ollama', model_id='claude-sonnet-5')   # broken
MODEL_PROVIDER=ollama + ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5
  → ModelSpec(provider='ollama', model_id='qwen2.5')           # correct
```

The same reasoning is why the dev-container pin is safe: a developer on the Ollama
default never sees it, which is what keeps the invariant's "dev and test default to
self-hosted Ollama" true.

---

## Invariants this contract must not break

| Invariant | Enforced by | Why it survives this feature |
|---|---|---|
| A per-user run uses that user's credential only — never a shared one | `runtime_env` drops an ambient key when the run carries none; `resolve_anthropic_key` reads only the per-run value | Untouched. No new credential, no new fallback. |
| A BYOK provider switch must not inherit another provider's model ids | `runtime_env` pops all three per-node pins when the per-user provider differs from the base | Untouched — and it is what makes the job-scoped pins above safe under BYOK. An Anthropic-pinned CI gateway serving an Ollama user drops the pin. |
| Escalation is always Anthropic frontier, and dormant | `select_model_config`'s `escalation` branch forces the provider; the flag defaults off; `escalation_or_base` degrades without a key | Untouched. |
| The merge gate is keyless | `guardrails.yml` runs `test:golden` in replay | Untouched — the new live assertion carries no `golden` marker, so it is not collected there. |
| A cassette miss fails, never skips | `invoke_or_skip` re-raises `CassetteMissError` by type before its text heuristic | Untouched, and constitutionally required. |

---

## Verification of this contract

The contract is verifiable without a credential, because `select_model_config` is pure:

```python
select_model_config("supervisor", {"MODEL_PROVIDER": "anthropic"})           # → fast tier (prod)
select_model_config("curator",    {"MODEL_PROVIDER": "anthropic"})           # → fast tier (changed)
select_model_config("supervisor", {"MODEL_PROVIDER": "anthropic",
                                   "SUPERVISOR_MODEL": "claude-sonnet-5"})   # → cached tier (CI)
```

The rows that need a live provider are exactly the two the new integration test covers:
that the cached-tier row actually produces a cache read, and that the production row
does not error on the marker it cannot use.
