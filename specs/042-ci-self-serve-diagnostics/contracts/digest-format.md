# Contract: Published failure digest

**Feature**: 042-ci-self-serve-diagnostics | Write side (US2)

## Publication channel

| Event | Channel | Identity |
|---|---|---|
| `pull_request` | PR comment, **upserted** | `<!-- ci-digest:job=<job_slug> -->` marker (FR-007) |
| `push`, `workflow_dispatch` | Commit status, `target_url` → bundle | context `ci-digest / <job_slug>` (FR-008) |
| *any, run cancelled* | **Nothing published** | FR-001a — see below |

**Suppression rule (FR-001a).** Before publishing, the script cross-checks the run's own state. A job
belonging to a cancelled/superseded run publishes **no digest and no bundle** — its records read as
failed, but the commit was never broken and the newer run will publish the truth. Without this, one
rapid re-push upserts a failure comment for every cancelled job.

## Upsert semantics

The marker is keyed by **job**, not run. Consequences:

- Same job failing 3× on a PR → **one** comment, edited twice.
- Two different jobs failing → **two** comments.
- Finding the comment to edit = list PR comments, match the marker. If absent, create.

## Format

```markdown
<!-- ci-digest:job=app-e2e -->
### ❌ CI failure — `app-ci` / `app-e2e`

| | |
|---|---|
| **Commit** | `7ab4ff2` |
| **PR** | #82 |
| **Failing step** | Run agent mobile flows (Maestro) |
| **Run** | [#1247](<forge>/…/actions/runs/1247) |

**Container health**
```
mc-service-store-mongo   unhealthy   exit 14  "connection refused"
movie-assistant-gateway  healthy
```

**`mc-service-store-mongo.log` (tail, truncated 4,812 → 200 lines)**
```
… last 200 lines …
```

**Not collected**
- Playwright report — absent (job failed before the web suite ran)

📦 Full evidence: `ci-failures:1247--app-e2e` → `node scripts/ci-status.mjs failure --run 1247 --full`
```

## Content rules

| Rule | Requirement |
|---|---|
| Excerpts are drawn from the **end** of each source | FR-003 — failures surface last; a head-biased excerpt is worthless |
| Hard cap **per source**: 200 lines / 32 KB (calibrate — OQ-3) | FR-003 |
| Truncation is **stated** (`4,812 → 200 lines`), never silent | FR-003 |
| Container health included when present | FR-004 |
| Absent evidence listed explicitly under **Not collected** | D5 — degradation is stated, not silent |
| Bundle pointer always present | FR-006 |

## Redaction (FR-005) — the most safety-critical rule here

Every field passes `redactForPublication()` before leaving the runner:

1. Globalised patterns rewrite JWTs, bearer tokens, `sk-ant-…` keys, and session cookies.
2. Any `*.ts.net` host → `<forge>`, matched **by shape**, never by embedding the literal (research R5).
3. **Verification pass** — the `secret-scan` detection rules re-run over the redacted output. Any
   surviving match **drops that excerpt entirely**, replaced with:
   `> ⚠️ Excerpt withheld — content matched a credential pattern after redaction.`

Step 3 is fail-closed by design. Detection and redaction disagree at the edges, and on that edge losing
a log excerpt is acceptable; leaking a credential into a PR comment — far more visible than a run log —
is not.

## Never change the job outcome (FR-009)

The step is `if: always()` + `continue-on-error: true`, and every internal failure is caught, reported
to the job log, and swallowed. A broken digest must never mask, replace, or delay a real failure. This
is the one property that must hold even if everything else in the feature is wrong.
