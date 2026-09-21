# Data model: LLM cost reduction, phase 1

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-09-20

This feature persists nothing and changes no schema. The "entities" below are the
in-memory and on-disk structures whose *values* or *shape* it changes, recorded here
because getting any of them wrong is how the feature fails silently.

---

## 1. `ModelSpec` — a resolved model choice for one graph node

**Where**: `agents/movie-assistant/src/models.py`

Unchanged, frozen dataclass: `provider: str`, `model_id: str`, `temperature: float`.
Produced by `select_model_config(node, env)`, which is pure over a `Mapping` — which is
what lets the new tests pin a model without mutating process env.

**What changes**: two entries in the defaults tables, not the structure.

| Table | Node(s) | Before | After | Reaches production? |
|---|---|---|---|---|
| `_FAST_DEFAULTS["anthropic"]` | `supervisor` | fast tier | **unchanged** | — (R8: moving it would cost users ≈2.5× per turn) |
| `_BALANCED_DEFAULTS["anthropic"]` | `curator`, `organizer`, `query` | balanced tier | **fast tier** | **Yes** — `compose.prod.yaml` pins nothing, so the code default rules |
| `_ESCALATION_DEFAULT` | `escalation` | frontier | **unchanged** | — (pinned and dormant, FR-014) |

**Invariant preserved**: `select_model_config` still raises on an unknown node, and the
`escalation` branch still forces `provider="anthropic"` regardless of the base provider.

---

## 2. Classification request — the structure that decides everything

**Where**: `agents/movie-assistant/src/nodes/supervisor.py` → `classify_intent`

This is the only *shape* change in the feature.

**Before** — one concatenated string ending in the user's text, so every byte of the
2,650-token taxonomy is re-sent and re-billed on every call:

```
"You route a user's message …<~2,650 tokens of taxonomy>… Message: {last}"
```

**After** — two messages, with the volatile part strictly after the cache marker:

| Part | Role | Content | `cache_control` | Must be |
|---|---|---|---|---|
| Static prefix | `system` | the taxonomy, labels, rules and examples | `{"type": "ephemeral"}` | **byte-identical on every call** (FR-006) |
| User turn | `human` | the latest user message text | — | free to vary |

**Field-level rules**:

- The system content is a **list of one content block**, `{"type": "text", "text": …,
  "cache_control": {"type": "ephemeral"}}`, not a bare string — a bare string cannot
  carry the marker.
- The static text MUST NOT interpolate anything. No timestamp, no session id, no
  option list, no f-string hole. This is the single validation rule that the whole
  saving depends on, and it is what the new unit test asserts.
- Cache-marker placement follows the render order `tools → system → messages`, so the
  marker at the end of `system` covers exactly the static prefix and nothing volatile.

**Cross-provider behaviour of this one shape** (verified, R1):

| Provider / model | Minimum cacheable prefix | Behaviour |
|---|---|---|
| Anthropic, cached tier | 1,024 | Marker honoured — prefix (~2,650) clears it; this is the saving |
| Anthropic, fast tier | 4,096 | Marker accepted and **ignored** — prefix does not clear it; billed as today |
| Ollama (`qwen2.5`) | n/a | Extra key dropped during content-part conversion; text extracted intact |

**Unchanged**: the return contract. `classify_intent` still lowercases and trims the
reply and still maps anything outside `INTENTS` to `"ambiguous"`, so `route_for_intent`
still routes an unknown label to `clarify` rather than guessing.

---

## 3. Cassette entry — the regenerated fixture

**Where**: `agents/movie-assistant/tests/golden/cassettes/*.json`

**Key**: `sha256(model_id + "\n" + "\n".join(f"{role}: {text}"))` over the normalized
input (`src/eval/cassette.py`). `_normalize` already accepts either a string or a list
of LangChain messages, so the message-list shape needs **no cassette-layer change** —
it stringifies each message's `content`, so the structured block becomes part of the
key. Deterministic, and therefore a correct key; but it does mean the key moves, which
is the intended loud failure.

**Regeneration matrix** (43 files, verified inventory):

| Keyed `model_id` | Count | Invalidated by | Re-recorded as | Credential |
|---|---|---|---|---|
| fast tier (intent) | 31 | prompt shape | same id | Anthropic key |
| balanced tier (extraction) | 11 | specialist default | **fast tier id** | Anthropic key |
| `qwen2.5` (topic confinement) | 1 | prompt shape | same id | **local Ollama** |

**Constitutional invariant**: a miss MUST fail and MUST NOT become a skip.
`invoke_or_skip` enforces this by re-raising `CassetteMissError` **by type, before** the
overload-text heuristic — necessary because a sha256 key beginning `429…`/`529…` would
otherwise trip the substring test and downgrade drift to a capacity skip. This ordering
is load-bearing and is not to be touched.

---

## 4. Cache-effectiveness signal — read for the first time

**Where**: `AIMessage.usage_metadata` on a live Anthropic response

Produced today on every call, consumed by nothing. This feature adds the first reader.

| Path | Source field | Meaning |
|---|---|---|
| `usage_metadata["input_token_details"]["cache_read"]` | `cache_read_input_tokens` | tokens served from cache — **the assertion target**, billed at ~0.1× |
| `usage_metadata["input_token_details"]["cache_creation"]` | `cache_creation_input_tokens` | tokens written to cache, billed at ~1.25× |
| `usage_metadata["input_tokens"]` | `input_tokens` | uncached tokens at full price |

**Expected transition across two back-to-back classifications on the cached tier**:

| Call | `cache_creation` | `cache_read` | Interpretation |
|---|---|---|---|
| 1st | ≈ prefix size | 0 | cold — the write is paid once |
| 2nd | 0 | ≈ prefix size | **warm — this is what the assertion requires to be > 0** |
| 2nd, if prefix drifted | ≈ prefix size | **0** | the failure the feature exists to detect — no exception, no error, just a zero |

**Not available under replay.** A `ReplayChatModel` reconstructs an `AIMessage` from a
recorded cassette and carries no usage metadata, which is precisely why this assertion
must run against the real provider and therefore belongs to the live-model tier.

---

## 5. Environment selectors — the deployment-shaped "entity"

**Where**: workflow job env, `scripts/agent-stack.mjs`, `devcontainer.json`,
`compose.prod.yaml`

Full per-surface table in [contracts/model-selection.md](./contracts/model-selection.md).
The one structural fact worth restating here: **production pins nothing on purpose**,
so the code defaults in §1 *are* the production configuration. That is what carries the
extraction saving to end users automatically, and it is why the supervisor choice must
stay a code default rather than a deployment setting — a deployment setting that goes
missing would silently move production onto the expensive path.
