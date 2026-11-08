# Tasks 094: The downscoped-token cache is keyed by the token presented

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [ ] **T001** Add the cache-key tests (FR-001, FR-002, FR-004).
  **Verify RED**: the forged-token, raw-token and prune cases fail; the existing cases pass.
- [ ] **T002** Key the cache by the subject-token digest and prune on `put`.
  **Verify GREEN**: the same tests pass, with the movie-assistant unit suite and lint.
- [ ] **T003** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
