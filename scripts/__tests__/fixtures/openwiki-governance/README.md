# Fixtures — `scripts/check-openwiki-governance.mjs` (feature 044, T002)

Each subdirectory is a **mini-repository root**, not a bundle root: it holds `CLAUDE.md`, `AGENTS.md`,
a `docs/` tree and an `openwiki/` bundle, because the governance rules span all of them. Drive the gate
with `--root <fixture>`.

Every fixture is the `valid/` baseline with **exactly one** mutation, so a failure names one rule and
nothing else. `diff -rq valid <fixture>` shows the mutation. A single mutation may raise more than one
FINDING of the same rule — `protected-on-derived` raises two G7s — but never a second rule; where that
was unavoidable the fixture was reshaped until it was.

| Fixture | Expected | Rule |
|---|---|---|
| `valid` | pass | the G1–G12 baseline |
| `unclassified-path` | fail | **G1** a documentation path no `policy.yaml` entry matches |
| `invalid-policy-value` | fail | **G2** `policy: sometimes` — outside the five declared states |
| `generator-outside-bundle` | fail | **G3** `actor: generator` on `docs/runbooks/**` — the mechanical expression of FR-026c |
| `event-driven-without-events` | fail | **G4** `event-driven` with no `events` |
| `reworded-passage` | fail | **G5** words changed under a protected anchor |
| `deleted-passage` | fail | **G6** the anchor is gone — must fail as a *removal*, not pass for lack of text to compare |
| `protected-on-derived` | fail | **G7** a protected passage on a concept carrying a `resource` — reported twice (not-authoritative, and resource-bearing), both G7 |
| `claude-stray-prose` | fail | **G8** a paragraph in `CLAUDE.md` outside the index and the three managed regions |
| `dangling-index-entry` | fail | **G9** an index entry pointing at a concept that does not exist |
| `stale-assistant-surface` | fail | **G10** `AGENTS.md` pointing at a path that has moved |
| `unclassified-concept` | fail | **G11** a concept that is neither derived nor authoritative |
| `both-classifications` | fail | **G11** a concept that is both |
| `whitespace-drift` | **pass** | normalization: CRLF + trailing spaces are not a change |
| `fingerprint-updated` | **pass** | FR-029d escape hatch: passage and fingerprint corrected in the same change |
| `missing-manifest` | fail | fail-closed: an absent `protected.yaml` is a violation, never a skip |
| `unparseable-policy` | fail | fail-closed: an unreadable `policy.yaml` is a violation |
| `authoritative-declared-regenerate` | fail | **G12** an authoritative concept whose effective policy is `regenerate` (data-model E4) |

## The fingerprints

`valid/openwiki/protected.yaml` hashes the section under `## Vendored OpenSSL is musl-conditional` in
`valid/openwiki/gotchas/musl-openssl.md`. Recompute any of them with the gate itself rather than by
hand:

```bash
node scripts/check-openwiki-governance.mjs --root scripts/__tests__/fixtures/openwiki-governance/valid \
  --fingerprint openwiki/gotchas/musl-openssl.md "Vendored OpenSSL is musl-conditional"
```

`whitespace-drift` deliberately hashes to the **same** value as `valid` — that equality is the property
T045 asserts. `reworded-passage` and `fingerprint-updated` share the same reworded text; only the
manifest differs, which is what makes one a violation and the other the sanctioned correction.
