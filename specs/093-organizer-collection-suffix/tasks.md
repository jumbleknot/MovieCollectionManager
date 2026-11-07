# Tasks 093: A collection named with a trailing "collection" still resolves

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Add the resolver and comparison tests (FR-001 to FR-004).
  **Verify RED**: the suffix cases fail, while the exact-match, create and reverse-direction cases pass.
- [X] **T002** Add the fallback to `_resolve_target` and the suffix rule to `compare.py`.
  **Verify GREEN**: the same tests pass, with the movie-assistant unit suite and lint.
- [X] **T003** Confirm no recorded response changes: the keyless golden replay passes (SC-003).
- [ ] **T004** Open the PR and get green CI. **Quote** the run numbers.
- [ ] **T005** After merge, the deploy's live-model gate passes. **Quote** the run. A pass on this run is one
  sample, not proof the model will not drift.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | `5 failed, 164 passed`: `test_plan_source_with_collection_suffix_matches`, `test_plan_destination_with_collection_suffix_matches`, and the three `test_resolve_target_trailing_collection_word_resolves` cases (`assert None == 'c-scifi'`). The exact-name, create-full-name, wrong-collection and one-way cases passed | Local |
| T002 GREEN | The same files: `169 passed`. Unit suite: `1234 passed, 1 skipped` (the skip is the existing `Identical years` property case). `ruff check`, `ruff format --check` on the changed source, and `mypy src`: no issues | Local |
| T003 | `LLM_CASSETTE_MODE=replay`, no key: `51 passed, 76 deselected` | Local |
| T004 | | |
| T005 | | |
