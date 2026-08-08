# Contract — the forge's issue surface, as observed

**Feature**: [../spec.md](../spec.md) | **Research**: [../research.md](../research.md)

Forge build: **`15.0.3+gitea-1.22.0`**. Base: `<scheme>://<host>:<port>/api/v1`, derived from
`git remote get-url origin` — **not** from `FORGE_REGISTRY_HOST`, which carries no port (research D1).
Auth header: `Authorization: token <value>`.

`R` below is `/repos/{owner}/{repo}`. **Measured** = observed on 2026-08-08 from the dev container.
**Unverified** = not exercised, because every probe was read-only by design.

## Read endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /version` | measured 200 | `{"version":"15.0.3+gitea-1.22.0"}` |
| `GET R` | measured 200 | `has_issues: true`, `external_tracker: null`, `internal_tracker.enable_issue_dependencies: true`, `permissions{admin,push,pull}` — the permission block is the FR-003 check in [../quickstart.md](../quickstart.md) |
| `GET R/issues?type=issues&state=…&page=&limit=` | measured 200 | `x-total-count` header carries the total; `link` header present. **`type=issues` is mandatory** — without it, pull requests interleave (143 rows vs 1) |
| `GET R/issues/{n}` | measured 200 | single item; **no** `x-total-count` |
| `GET R/issues/{n}/comments` | measured 200 | list; `x-total-count` present |
| `GET R/issues/{n}/dependencies` | measured 200 | the item's **blockers**; array, no total header |
| `GET R/issues/{n}/blocks` | measured 200 | the items it **blocks**; array, no total header |
| `GET R/issues/{n}/labels` | measured 200 | array |
| `GET R/issues/{n}/timeline` | measured 200 | list with total; available if provenance is needed |
| `GET R/labels` | measured 200 | **0 labels defined today** — setup creates the taxonomy |
| `GET R/milestones?state=all` | measured 200 | **0 milestones defined today** |
| `GET R/issue_templates` | measured 200 | returns `null` — no template configured yet |
| `GET R/issue_config` | measured 200 | `{blank_issues_enabled, contact_links}` |
| `GET R/issue_config/validate` | measured 200 | `{valid, message}` — the acceptance check for the YAML form once it is on the **default branch** (research D8) |
| `GET /user` | measured **403** with both tokens | neither carries `read:user`; token identity cannot be confirmed via API (research D5) |

## Write endpoints — required, unverified

Deliberately not exercised during planning. Each is verified once, in order, by the sequence in
[../quickstart.md](../quickstart.md), and each must also be shown to **403 under `MCM_FORGE_TOKEN`** —
without that negative half, the scope split is asserted rather than proven.

| Operation | Endpoint | Expected |
| --- | --- | --- |
| create item | `POST R/issues` | 201, body echoes the assigned `number` |
| edit / close / reopen | `PATCH R/issues/{n}` | 200. **Close is `{"state":"closed"}` on this endpoint — there is no close verb** |
| comment | `POST R/issues/{n}/comments` | 201 |
| add label(s) | `POST R/issues/{n}/labels` | 200 |
| remove label | `DELETE R/issues/{n}/labels/{id}` | 204 — note: label **id**, so a name must be resolved first |
| add dependency | `POST R/issues/{n}/dependencies` | 201 |
| remove dependency | `DELETE R/issues/{n}/dependencies` | 200 |
| create label | `POST R/labels` | 201 (setup only) |
| create milestone | `POST R/milestones` | 201 (setup only) |
| close a blocked item | `PATCH R/issues/{n}` | **refused** — status and message shape unobserved; capture it and use the captured response as the classifier's fixture (FR-010) |

## Query-parameter behaviour — measured

| Parameter | Behaviour | Consequence |
| --- | --- | --- |
| `type=issues` \| `type=pulls` | honoured, exact | always send `type=issues`; a backlog listing without it is ~99% pull requests here |
| `limit` | default **30**, hard cap **50** (`limit=60` → 50 rows; `limit=200` → 50 rows) | never trust a 50-row answer as complete; page against `x-total-count` |
| `limit` without `page` | **honoured** — page size applied (3 rows for `limit=3`) | the `actions/runs` "limit silently ignored" quirk does **not** transfer; keep pairing them for explicitness, not as a workaround |
| `page` | honoured; `page=2&limit=3` returned the correct next 3 | — |
| `q` | honoured, fails **closed** (nonexistent text → 0 rows, total 0) | safe to use server-side |
| `labels=<unknown-name>` | **silently ignored — returns the UNFILTERED set** (total 1, same as no filter, with 0 labels defined) | resolve every label name against `GET R/labels` first and refuse unknowns; a typo would otherwise read as "matched everything" (research D3) |
| `labels=<real-name>` | **unmeasured** — no labels exist yet | re-measure once the taxonomy is created: match semantics, comma-separation, AND vs OR (FR-017) |
| `state=open\|closed\|all` | honoured | — |

## Response headers

| Header | Where | Use |
| --- | --- | --- |
| `x-total-count` | list endpoints only (absent on single-item GETs, absent on `dependencies`/`blocks`) | the authoritative total — FR-008 forbids inferring it from row count |
| `link` | every list response | cross-check for paging; secondary to `x-total-count` |

## Repository facts that shape the design

- **Issue and pull-request numbers share one sequence.** Pull requests currently occupy #100–#143; the
  only issue is #29. A bare `#N` is ambiguous — write `item #N` (research D4).
- **Item #29 "Dependency Dashboard" is Renovate-managed** and authored by the operator's own account, so
  author-based exclusion is useless. It gets `status/bot-managed` and is excluded from sweeps.
- **Issue dependencies are enabled** on this repository, so the dependency graph is usable as the
  readiness authority.
- **Projects boards expose no API in this build** — board state is invisible to the tool; labels are the
  shared truth and the skill must say so.
