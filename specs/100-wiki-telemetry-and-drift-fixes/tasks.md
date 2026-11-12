# Tasks 100: The wiki generator's telemetry opt-out is checked, and three claims the wiki repeated are made true

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Probe the opt-out at $0 (invalid key, scratch repository) with each variable alone and
  with both. Read the payload from `buildRunEvent`.
- [X] **T002** Tests for the launcher tripwire and the orchestrator stop (`wiki-generate.test.mjs`,
  `wiki-maintain.test.mjs`). **Verify RED** against the old scripts.
- [X] **T003** Implement the tripwire in `wiki-generate.mjs` and `wiki-maintain.mjs`. **Verify GREEN**,
  then run the whole wiki script suite.
- [X] **T004** Guard test `python-runtime-readonly-app.guard.test.mjs`. **Verify RED** against an old
  Dockerfile.
- [X] **T005** Make `/app` root-owned in the four Python images and correct their comments.
  **Verify GREEN**, build the images, and check them.
- [X] **T006** Reverse-order route test in `router.rs`, then correct the comment. This test
  characterises axum's behaviour rather than driving new code, so there is no RED step. Its result
  decided the comment.
- [X] **T007** Document the fallback, the telemetry measurement and decision, and item #515's rejection
  in the runbooks. Refresh the affected wiki pages and correct the two pages that repeated the claims.
- [X] **T008** Run the gates: okf-lint, okf-governance, mc-service lint and unit tests, and the script
  tests.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 | All three probes wrote `{"disabled": true, "sent": false}` (openwiki 0.7.1) | Local |
| T002/T003 | RED: launcher 8 pass / 7 fail, orchestrator 0 / 4 on the old scripts. GREEN: `node --test scripts/__tests__/wiki-*.test.mjs scripts/__tests__/python-runtime-*.test.mjs` gave 206 pass, 0 fail, 0 skipped | Local |
| T004/T005 | The guard named `web-api-mcp/Dockerfile: COPY --chown on /app` against the old file. In all 4 built images `touch /app/x` and `touch /app/.venv/x` as `app` were refused. The 3 MCP `import src.server` succeeded; the gateway `/health` returned 200 with no permission errors | Local |
| T006 | `cargo test --lib literal_movie_segments`: 1 passed | Local |
| T008 | `okf-lint` and `okf-governance` passed. mc-service `lint` and `test:unit` passed (161 tests), and `cargo fmt --check` is clean. `node --test scripts/__tests__/*.test.mjs` gave 1924 pass, 0 fail, 0 skipped after recording `wiki-generate.mjs`'s #500 verdict. `secret-scan`, resource-naming, inline-secret, topology-scrub and argv-secret gates passed. `wiki-refresh --stale` printed nothing | Local |
