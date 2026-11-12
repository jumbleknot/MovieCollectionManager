# Plan 100: The wiki generator's telemetry opt-out is checked, and three claims the wiki repeated are made true

**Spec**: [spec.md](./spec.md)

## Approach

### #516: telemetry

- **Measurement.** A keyless run stops at the credential check, before openwiki's telemetry boundary,
  and writes no record. An *invalid* key gets past that check and fails inside the boundary, so the run
  is still recorded. That gives a $0 probe. It runs in a throwaway git repository, because `--update`
  scaffolds `AGENTS.md` and `openwiki/` in its working directory.
- **The payload, read rather than sent.** `buildRunEvent` is a pure function, so the payload comes
  from reading it. `--telemetry-file` writes its record after `capture()`, so it never prevents the send.
- **Launcher (`scripts/wiki-generate.mjs`).** `launchEnv` overrides both variables. `generatorArgs`
  takes the record path, which comes from `WIKI_TELEMETRY_FILE` or a fresh temp path, and the launcher
  deletes any stale record first. The new `judgeTelemetryRecord` is the single verdict function.
- **Orchestrator (`scripts/wiki-maintain.mjs`).** It needs its own check because it ignores the
  generator's exit status by design. It reuses the existing per-invocation `usageDir` and judges the
  record after each attempt. On a bad record it does not retry and stops after the slice's normal
  restore handling, so failed pages still cannot ride along on a proposal. It adds `telemetrySent` to
  the result and exits 1.

### #604: the three claims

- **Images.** `COPY --from=build /app /app` without `--chown`. The servers bind a port and read code;
  the only save, spreadsheet-mcp's workbook, writes to an in-memory buffer. The guard follows the
  pattern of `python-runtime-no-pip.guard.test.mjs`.
- **Routes.** An inline `#[cfg(test)]` test with stub handlers registers the routes in the order the
  comment forbade. It passes, so the comment is replaced with what the test shows.
- **Fallback.** One paragraph in the agent-layer runbook, then refresh `projects/agent-gateway.md` and
  record `architecture/agent-layer.md` with no body change. `projects/mcp-servers.md` and
  `projects/mc-service.md` repeat the corrected claims, so their bodies are corrected as well. Their
  shared source, `docs/MCM-Architecture.md`, never stated them.

## Rollback

Revert the commit. The images become writable again, and the tripwire goes away.
