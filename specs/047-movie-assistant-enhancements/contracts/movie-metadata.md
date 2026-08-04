# Contract: supported movie option values (mc-service endpoint + movie-mcp tool)

**Feature**: [047](../spec.md) · **Story**: US4 · **Satisfies**: FR-021, FR-024 · **Resolves**:
[RQ-4](../research.md#rq-4)

The assistant must offer exactly the media formats and rip qualities mc-service accepts. Those
values are domain data, and the constitution's *No Domain Logic in Agents* forbids the agent owning
them. So the domain publishes them and the agent asks.

This adds one read endpoint to mc-service and one thin read tool to movie-mcp. It is the only part
of this feature that reaches outside the agent layer.

## Why the existing `filter-options` endpoint cannot serve this

`GET /api/v1/collections/{id}/movies/filter-options` returns the values **observed** in that
collection — it aggregates over stored movies
([get_filter_options.rs](../../../backend/mc-service/src/application/queries/get_filter_options.rs)).
An empty collection returns empty lists, and a collection of DVDs would hide Blu-Ray. It answers
"what can I filter by here", not "what may I choose". Reusing it would silently offer the member a
shrinking set of formats as their collection narrowed.

---

## 1. mc-service — `GET /api/v1/movie-metadata`

**Placement**: a sibling of `/collections` inside the existing `protected` router
([router.rs:170-175](../../../backend/mc-service/src/api/router.rs#L170-L175)), so it inherits
`auth_layer` then `require_app_role`. **No per-handler role check** — role enforcement stays a
layer, per [role-enforcement-is-a-layer](../../../openwiki/gotchas/role-enforcement-is-a-layer.md).

**Request**: no parameters. Not collection-scoped, so no DAC check applies — it returns no user data.

**Response** `200 application/json`:

```json
{
  "mediaFormats": ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]
}
```

| Field | Type | Notes |
|---|---|---|
| `mediaFormats` | `string[]` | Every accepted `MediaFormat`, in display order. Used for **both** `ownedMedia` and `ripQuality` — they share the enum. |

The strings are the **serde wire representations**, not the Rust variant names — `"Blu-Ray"`, not
`BluRay`. These are exactly what `add_movie` accepts in `ownedMedia` / `ripQuality`, so a value the
member picks is a value mc-service takes. A test must assert round-trip: every returned string
deserialises back into a `MediaFormat`.

The response is an **object, not a bare array**, so publishing further enumerations later
(content types, ratings) is additive rather than breaking. Only `mediaFormats` is in scope here.

**Errors**: `401` without a token, `403` without `mc-user`/`mc-admin` — both from the existing
layers, no new error path. Any failure body is RFC 9457 Problem Details like every other endpoint.

### Drift protection (the point of the whole exercise)

The list must be **derived from the enum**, not typed out beside it. Implement it as an exhaustive
`match` over `MediaFormat` (or an equivalent that names every variant), so that adding a variant
**fails to compile** until the new value is placed in the list. A hand-maintained `const` array is
rejected — it is the same silent-rot failure the agent-side hardcode was rejected for, moved one
crate over.

Unit test: the endpoint returns exactly the same set the domain accepts, and every entry
deserialises back into a `MediaFormat`.

---

## 2. movie-mcp — `get_movie_metadata`

A thin wrapper over the endpoint, matching the existing read tools in
[server.py](../../../mcp-servers/movie-mcp/src/server.py) — same `tool_span`, same
`make_mc_client(MC_SERVICE_URL, get_request_token())`, propagating the caller's JWT. **No domain
logic, no transformation**: it returns the endpoint's body unchanged.

```python
@mcp.tool()
async def get_movie_metadata() -> dict[str, Any]:
    """The values mc-service accepts for a movie's media formats and rip quality."""
```

---

## 3. Agent gateway wiring

- Add `get_movie_metadata` to `_READ_TOOLS` in
  [mcp_tools.py](../../../agents/movie-assistant/src/tools/mcp_tools.py) and to the **organizer's**
  allowlist. No other agent needs it — least privilege.
- The organizer calls it when building the media-format and rip-quality multi-selects, and passes
  the values into `render_multi_select` as the option labels and values.

### Caching

Cache the result process-wide with a short TTL (minutes) rather than fetching twice per add.

This is safe **because the response contains no user data** — it is the domain's own enum, identical
for every caller, so a value cached against one member's request and served to another leaks
nothing. That reasoning is why the cache is acceptable here and must not be copied to any read that
returns collections or movies, which are user-scoped and must never be cross-served.

The call still carries the caller's token; only the response is shared.

### Failure behaviour

If the metadata call fails, the assistant **must not invent the list**. It skips the media-format
question, proceeds with the add as owned with no formats recorded (which FR-028 already permits),
and tells the member they can set the formats on the movie's detail screen.

Degrading to a guessed list would put domain values back in the agent — the exact thing this
contract exists to prevent.

---

## What must be tested

| Level | Assertion |
|---|---|
| mc-service unit | The endpoint lists every `MediaFormat` variant; adding a variant breaks the build until it is included. |
| mc-service unit | Every returned string deserialises back into a `MediaFormat`. |
| mc-service integration | `401` without a token; `403` without the app role — reusing the authenticated harness from features [045](../../045-mc-service-http-authz-tests/plan.md)/[046](../../046-authenticated-authz-tests/plan.md). |
| movie-mcp integration | The tool returns the endpoint's body unchanged, against a **real** mc-service — mocking the dependency under integration is prohibited. |
| agent unit | The multi-select is built from the fetched values, not a literal. |
| agent unit | A metadata failure skips the question and still completes the add, recording no formats. |
| agent unit | `get_movie_metadata` is denied for every agent except the organizer. |
