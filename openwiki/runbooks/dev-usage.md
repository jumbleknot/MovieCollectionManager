---
type: Runbook
title: Claude Code token usage capture (prod-dev-usage)
description: How every dev-container Claude Code session ships per-session, per-turn and per-tool token counts — never content — through committed lifecycle hooks and scripts/cc-usage.mjs to the tailnet-only prod-dev-usage store (Postgres + PostgREST on 19040, Keycloak client-credentials tokens), the operator setup that turns it on, what doctor reports, and the traps — best-effort SessionEnd, the per-session lock and spool order, the JWKS fetched only at deploy, and not-configured meaning do nothing.
resource: docs/runbooks/dev-usage.md
resource-sha256: a96577b8738680ab2eea718290c09db90270df7c64775fe6da1246d9ddbd7b5b
tags: [claude-code, usage, tokens, postgrest, keycloak, devcontainer, runbook]
timestamp: 2026-11-22T00:16:45.441Z
---

# Claude Code token usage capture (prod-dev-usage)

Feature 105. Three hooks committed in `.claude/settings.json` (`SessionStart`, `Stop`, `SessionEnd`) run
`node scripts/cc-usage.mjs hook`. The script reads only the new bytes of the session's JSONL transcripts,
reduces them to names, counts and sizes, and upserts them over HTTP to the `prod-dev-usage` Komodo stack:
Postgres (schema `usage`) behind PostgREST, published on **19040**, tailnet-only. Every request carries a
short-lived Keycloak token for the service-account client `dev-usage-capture`, cached in the container
until 60 s before it expires. The runbook has the one-time operator setup (ending with a reinstall of the host backup copies,
which do not dump the store until then), the `doctor` reference, key rotation, restore and the
format-drift procedure.

## Load-bearing gotchas

- **No content ever ships.** A per-table allowlist (`privacy-shape.mjs`) drops every field not in the
  data model, and a guard test plants sentinels in every content field of the fixtures. A Bash
  command ships only its sanitized first word, never a `VAR=value` assignment, which can hold a URL.
  A file path ships only as its top-level area.
- **Not configured means do nothing.** With any of `MCM_USAGE_INGEST_URL`, `MCM_USAGE_TOKEN_URL`,
  `MCM_USAGE_CLIENT_SECRET` unset, the hooks parse nothing and spool nothing. The first configured
  sweep backfills from the transcripts still on the volume. The URLs are tailnet topology and never
  committed; the secret rides the `--env-file` path.
- **A hook never disturbs the session.** Every path exits 0 with empty stdout (`SessionStart` stdout
  would enter the model's context) and empty stderr. A `Stop` inside the 15-minute ship interval does
  no parse and no network.
- **`SessionEnd` is best effort.** A killed process, and so a VM idle-stop, fires none. The
  `SessionStart` sweep over **every** `projects/*/` directory recovers what was missed, and marks a
  session silent for over 24 h `inferred-stale`.
- **Ships are ordered per session.** Turn and tool rows are cumulative upserts, so every ship (Stop,
  SessionEnd, sweep, spool replay) runs under that session's lock and replays its spool oldest first.
  Otherwise an old batch could regress newer rows.
- **The store learns Keycloak's keys only when PostgREST starts.** PostgREST cannot fetch a JWKS URL, so
  an init container fetches it into a volume. Like every prod init, it then idles under
  `restart: always` behind a ready marker, because Komodo counts an exited container as unhealthy. After a signing-key rotation, `doctor` says `store rejects token`
  until the stack is redeployed.
- **Production's realm is hand-configured.** The client in `prod-realm.json` applies only to a fresh
  realm. The running realm needs the console steps.
- **The integration tier is its own stack.** `pnpm nx dev-usage-integration infrastructure-as-code`
  brings up compose project `dev-usage-it`, with its own Keycloak importing `ci-realm.json`, and
  removes it afterwards. It never touches the auth stack's fixed volume names. In the Docker Sandbox a
  worktree bind mount arrives empty, so it seeds the schema and realm with `docker cp`.
