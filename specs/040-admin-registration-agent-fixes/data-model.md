# Phase 1 Data Model: Feature 040

Only Item 1 introduces a new persisted entity. Items 2–4 add small in-memory/checkpointed agent state fields and reuse an existing movie attribute. mc-service data is unchanged.

---

## New entity — Application Settings (global)

**Store**: MongoDB collection `app_settings` (BFF-owned), a **single document**. External-contract names (collection + field keys) are stable and exempt from the behavior-descriptive-identifier rule (annotated in code).

| Field | Type | Notes |
|---|---|---|
| `_id` | string | Fixed sentinel `"global"` — exactly one settings document exists. |
| `allowSelfRegistration` | boolean | Whether user self-registration is permitted app-wide. **Absent document / absent field ⇒ treated as `true`** (default preserves current behavior, SC-004). |
| `updatedBy` | string \| null | Keycloak user UUID of the admin who last changed it (never username/email). Null before first write. |
| `updatedAt` | ISO-8601 string \| null | Timestamp of last change. Null before first write. |

**Access module**: `frontend/mcm-app/src/bff-server/app-settings-store.ts` (mirrors `agent-config-store.ts`):
- `getAppSettings(): Promise<AppSettings>` — reads the `"global"` doc; returns the default (`allowSelfRegistration:true`) when absent.
- `setAllowSelfRegistration(allowed: boolean, updatedBy: string): Promise<AppSettings>` — upserts the `"global"` doc with `updatedAt` stamped.

**Validation rules**:
- `allowSelfRegistration` must be a boolean (PATCH body validated; reject otherwise with a typed 400).
- Reads never fail-open on error in a way that *enables* a disabled state silently: an unexpected store error on the enforcement path (register) should be treated conservatively and surfaced (fail closed to "registration attempt refused with an error", not silently allowed) — decided in `register+api.ts` handling.

**Lifecycle / transitions**: `true ⇄ false` only, via admin PATCH. No deletion. First PATCH creates the document.

---

## Existing attribute reused — Movie.owned (Item 2)

No schema change. Confirms current behavior is honored:

- mc-service `domain/movie.rs`: `owned: bool`; `CreateMovieDto.owned` is `#[serde(default)]` ⇒ **false** when omitted; the create command passes it through unchanged.
- Cross-field invariant (unchanged): `owned=false` clears `owned_media` (`OwnedMediaWhenOwnedSpec`). The ownership Yes/No answer only sets `owned`; it does not set `owned_media`.
- Agent change: `to_movie_payload()` sets `owned` from the user's answer instead of the hardcoded `True`.

---

## Agent GraphState additions (Items 2 & 4) — checkpointed routing/UI state only

All fields hold UI/routing state only — **never tokens or credentials** (constitution §Identity Propagation). Added to `GraphState` in `graph.py` and cleared by the relevant `_*_STATE_RESET` dicts.

| Field | Item | Purpose |
|---|---|---|
| `add_stage` value `awaiting_ownership` (+ any stash field for the pending candidate/target/ownership answer) | 2 | Marks the add flow paused on the "Do you own this?" Yes/No; resolved on the next turn before building the proposal. Added to `_ADD_STATE_RESET` (in both `graph.py` and `approval_gate.py`). |
| `navigate_stage` | 4a | Marks the navigator paused on a "Which collection?" pick (mirrors `search_stage`/`import_stage`). Enables the `graph.py` continuation guard to keep the tap in the navigator. |
| `navigate_options` (or equivalent pending-prompt options) | 4a | The candidate collections offered, so the resumed bare-token tap resolves to the chosen collection. Cleared on resolution. |

---

## Agent import state change (Item 3) — handle instead of full dataset

| Before | After |
|---|---|
| `import_context = { tabs, collections }` — the **entire parsed spreadsheet** (all rows) re-serialized into `GraphState` and checkpointed on every clarification turn. | A **transient handle/reference** to the parsed spreadsheet (reuse the spreadsheet-mcp transient `store`), checkpointed in place of the full dataset. The large row data lives behind the handle, not in per-turn checkpoint state. |

**Rationale**: bounds checkpoint size across many clarification turns on large files (Item 3 timeout cause). The handle must remain valid across the clarification turns of a single import session.

---

## Audit records (Item 1) — emitted, not stored by this feature

Via `logger.audit` (existing structured logger; not a new collection):
- `admin_setting_changed` — `{ setting:"allowSelfRegistration", value, userId (admin UUID), ip }` on PATCH.
- `registration_refused_disabled` — `{ userId?: n/a, ip }` when a registration attempt is refused because the setting is off (§Logging: audit access-denied/refusals).
