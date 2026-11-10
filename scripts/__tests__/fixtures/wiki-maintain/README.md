# Fixtures — `scripts/wiki-maintain.mjs` (feature 044, T001)

The mini-bundle the verifier tests and `--selftest` drive, plus the measured invocation durations the
guard test derives the job timeout from. Everything loads **offline**, with no network and no
`ANTHROPIC_API_KEY` — the verifier judges a slice by what is on disk, never by asking anything. (The
planner's fixtures went with range planning, feature 098.)

| Fixture | Shape | What it proves |
|---|---|---|
| `conformant-bundle/` | Root `index.md`, one area (`invariants/`) with its own `index.md` and one listed concept | The verifier's success path: pages present **and** `check-openwiki-okf.mjs` clean |

Derived fixture pages cite `scripts/__tests__/fixtures/wiki-maintain/source.txt` by its repository
path and carry its fingerprint (`resource-sha256`, V17, feature 098). The OKF gate resolves a
repo-relative `resource` against the repository root, not the bundle root, so the path must be the
repository one; and a stable fixture file, unlike `README.md`, cannot go stale under the fixtures.
Editing `source.txt` means re-recording `conformant-bundle/invariants/auth-chain.md`
(`node scripts/wiki-refresh.mjs` cannot reach fixture bundles; recompute the hash the same way).
