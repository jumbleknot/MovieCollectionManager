# Contract: OKF rule V17 — a derived page matches its source

Runs inside `node scripts/check-openwiki-okf.mjs`, which is the `guardrails / okf` required context
on every PR and push.

**Fails** (exit 1) when any derived page:

- **has no `resource-sha256`, or it is malformed.** The message is
  `V17 <page>: no source fingerprint — run: node scripts/wiki-refresh.mjs --record <page> (after refreshing it)`.
- **has a hash that does not match the current source.** The message is
  `V17 <page>: stale against <resource> — refresh it: node scripts/wiki-refresh.mjs --diff <page>, update the page, then --record <page>. Skill: wiki-refresh`.
- **names a `resource` that does not exist** (renamed or deleted). The message is
  `V17 <page>: its source <resource> no longer exists — re-point resource: at the file that now holds this subject (then --record), or retire the page`.
- **still carries `sources:` or `verified:`.** The message is
  `V17 <page>: forbidden field <name> (retired with Claims, ADR-0004)`.

**Never evaluates** canonical pages (no `resource`).

**Self-test** (`--selftest`) scenarios, each RED before the rule exists:

- `v17-fresh` passes,
- `v17-stale` fails, naming the page,
- `v17-missing` fails,
- `v17-malformed` fails,
- `v17-crlf` passes: a CRLF copy of a fresh source,
- `v17-canonical-ignored` passes,
- `v17-sources-field` fails,
- `v17-resource-missing` fails.

Governance rule (in `check-openwiki-governance.mjs`, numbered G14):

- a directory `resource` fails,
- a `resource` matching the automated-writer deny-list (research R4) fails.
