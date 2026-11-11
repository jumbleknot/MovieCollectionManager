# Data Model: Session-Maintained Wiki Summaries (098)

## E1 — Derived page (front matter)

A concept under `openwiki/` with a `resource`. After this feature:

| Field | Required | Rule |
|---|---|---|
| `type`, `title`, `description`, `tags` | yes | unchanged (OKF V1–V4) |
| `resource` | yes | a **single repository file** (FR-006), not a directory, and not on the automated-writer deny-list (R4) |
| `resource-sha256` | yes | 64 lowercase hex characters: the SHA-256 of `resource` after normalising CRLF to LF (R1) |
| `timestamp` | yes, after the first refresh | ISO 8601 UTC, written by the record command (R2) |
| `generated` | optional | provenance of the last generator rewrite; left alone by a session refresh |
| `sources` | **forbidden** | stripped (FR-013); its presence fails V17 |
| `verified` | **forbidden** | stripped (R2); its presence fails V17 |

**State transitions**

```
fresh ──(source bytes change)──▶ stale ──(session edits body if needed, records)──▶ fresh
fresh ──(resource renamed or deleted)──▶ broken ──(re-point or retire the page)──▶ fresh
```

- **Fresh** means the recorded `resource-sha256` equals the hash of the current file.
- **Stale** means the two differ. V17 fails.
- **Broken** means the `resource` does not resolve. V3 already fails this today, and V17 adds the
  refresh hint.

## E2 — Canonical page

A concept with no `resource`, listed under `authoritative:` in `openwiki/protected.yaml` and
guarded by passage fingerprints (G5–G7). This feature changes two things for these pages:

- **Gains**: `process/spec-driven-development.md` and `architecture/data-model.md` (R3). They lose
  `resource`, `sources` and `verified`, and gain a `protected.yaml` entry. Their effective policy
  must be `event-driven` (G12), with an event of `process-changed` or `domain-model-changed`
  respectively.
- **Unaffected**: V17 never evaluates a canonical page.

## E3 — Regeneration policy entry (`openwiki/policy.yaml`)

| Field | Change |
|---|---|
| `actor` | `string` **or** `string[]`, each member one of `ACTORS` (R6) |

- `openwiki/**` becomes `actor: [agent, generator]`.
- The entries for `openwiki/.claims/**` and `openwiki/.page-manifest.json` are removed.

## E4 — Retired artifacts (gitignored, never tracked again)

- `openwiki/.claims/`
- `openwiki/.page-manifest.json`
- `openwiki/.last-update.json`
- `openwiki/.maintenance-state.json` (deleted; also gitignored so a stray rebuild cannot recommit it)
