# Fixtures — `scripts/wiki-maintain.mjs` (feature 044, T001)

Three mini-bundles the planner and verifier tests drive. Every one loads **offline**, with no network
and no `ANTHROPIC_API_KEY` — the planner makes no model call by contract (FR-003), and the verifier
judges a slice by what is on disk, never by asking anything.

| Fixture | Shape | What it proves |
|---|---|---|
| `conformant-bundle/` | Root `index.md`, one area (`invariants/`) with its own `index.md` and one listed concept | The verifier's success path: pages present **and** `check-openwiki-okf.mjs` clean |
| `partial-bundle/` | An area holding a concept with **no** `index.md`, plus a concept missing `type` | The conformance-regression path (T016): a slice that writes pages but leaves the bundle non-conformant is a **failure**, not a success |
| `new-and-existing-areas/` | One existing area (`gotchas/`) and nothing at `runbooks/` | `areaExists` must be **derived from the tree** (T009), and a slice may never mix a new area with an existing one — the only shape that produced zero pages across 043's eight runs |

`resource` fields point at `README.md` at the repository root, which resolves for real: the OKF gate
resolves repo-relative resources against the repository root, not the bundle root, so a fixture that
cited a fixture-local file would fail V6 for the wrong reason.
