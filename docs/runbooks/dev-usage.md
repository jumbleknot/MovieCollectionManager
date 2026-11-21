# Runbook — Claude Code token usage capture (`prod-dev-usage`)

Feature 105 ([spec](../../specs/105-cc-token-usage-capture/spec.md)). Every Claude Code session in the
dev container ships per-session, per-turn and per-tool **counts** to a small store on the homelab, so
usage can be compared over time. This page is the operator's half: one-time setup, checks,
troubleshooting, restore. Nothing here is needed to merge the code. Until the setup is done, capture is
**not configured**: the hooks do nothing, and the transcripts on the volume stay the source. The first
configured session's sweep catches up on everything still on the volume.

## 1. What is captured, and what never is

**Shipped** (data-model.md): session ids, the `projects/` directory name, the starting worktree's last
path segment and branch, model names, token counts by type (input, output, cache read, 5-minute and
1-hour cache writes, thinking), timestamps, turn boundaries and origin, compaction counts, tool **names**
with call counts and result **sizes**, the first word of each Bash command (`pnpm`, `git` — sanitized,
never an argument), skill names, the top-level repository areas a turn touched (`docs`, `scripts`), and
a re-read count.

**Never shipped**: prompt or assistant text, tool input or output, file contents, file paths, command
arguments, subagent descriptions, host names, the token or the client secret. A per-table allowlist
(`scripts/lib/cc-usage/privacy-shape.mjs`) drops anything else, and a guard test plants sentinel strings
in every content field of the fixtures and fails if one reaches a shipped batch.

**Classification: internal.** The store is tailnet-only, and every request carries a Keycloak token.

## 2. How it fits together

```text
dev container                                       homelab (prod daemon)
  .claude/settings.json hooks ─► scripts/cc-usage.mjs ──POST, Bearer──►  dev-usage-postgrest :19040
   SessionStart / Stop / SessionEnd   │                                     │ verifies the token against the
                                      └─ client-credentials ─► Keycloak     │ realm JWKS (fetched at deploy)
                                         (:19099, tailnet)                  ▼
                                                                          dev-usage-postgres (schema usage)
```

- Local state, spool and log: `$CLAUDE_CONFIG_DIR/usage/` on the persistent volume.
- At most one ship per session per 15 minutes, plus one at `SessionEnd`; at most one sweep of every
  project directory per container per 15 minutes. `SessionEnd` is best effort: a killed process fires
  none, and the sweep marks a session that has been silent for over 24 hours `inferred-stale`.
- Offline: a failed ship spools its batch (capped at 50 MB, oldest dropped first) and backs off for 5
  minutes. Nothing ever fails a session or prints into it.

## 3. One-time setup (operator)

Do the steps in order. Each says what you should see.

### 3.1 Keycloak: the `dev-usage-capture` client in the production realm

Production's realm is configured by hand: a realm file applies only when the realm is first created
(`infrastructure-as-code/docker/keycloak/README.md`). `prod-realm.json` carries the same client, for a
fresh realm. In the admin console (tailnet, `http://<tailnet-host>:19099/admin`), realm **grumpyrobot**:

1. **Clients → Create client.** Client type *OpenID Connect*, Client ID `dev-usage-capture`, name
   `Claude Code usage capture (feature 105)`. Next.
2. **Capability config.** Client authentication **On**. Under Authentication flow, tick **only**
   *Service accounts roles*: untick *Standard flow* and *Direct access grants*. Save.
3. **Advanced → Advanced settings → Access Token Lifespan: 60 minutes.** Save.
4. **Client scopes → `dev-usage-capture-dedicated` → Configure a new mapper → Hardcoded claim.**
   Name `role-usage-writer`, Token Claim Name `role`, Claim value `usage_writer`, Claim JSON Type
   *String*, *Add to access token* **On**, *Add to ID token* and *Add to userinfo* **Off**. Save.
5. Same screen: **Add mapper → By configuration → Audience.** Name `aud-dev-usage`, Included Custom
   Audience `dev-usage`, *Add to access token* **On**, *Add to ID token* **Off**. Save.
6. **Credentials** tab: copy the **Client Secret**. You need it in 3.5. Do not paste it anywhere else.

Expected: the client is listed, *Service accounts* enabled, two mappers on its dedicated scope.

### 3.2 Komodo Variables

Create three **secret** Variables (Komodo → Settings → Variables), each a long random string (for
example `openssl rand -hex 24` on the prod host, pasted into the UI and not into a chat):

| Variable | Used by |
| --- | --- |
| `DEV_USAGE_PG_PASSWORD` | the Postgres superuser (`dev_usage`); also what the nightly backup's `pg_dump` uses |
| `DEV_USAGE_AUTHENTICATOR_PASSWORD` | PostgREST's `authenticator` login |
| `DEV_USAGE_READER_PASSWORD` | Grafana's read-only `usage_reader` login (the dashboard arrives with US3) |

The `prod-dev-usage` block in `infrastructure-as-code/komodo/stacks.toml` already references them.

### 3.3 The two volumes, and a firewall check (prod host, `sudo machinectl shell prod@`)

```bash
docker volume create dev-usage-postgres-data
docker volume create dev-usage-jwks-data
docker volume ls --format '{{.Name}}' | grep -c '^dev-usage-'
```

Expected: the two names echoed by `create`, then `2`. Both volumes are `external`: a production stack
never creates its own, so a deploy without them aborts before changing any container.

**No port rule is needed for 19040.** The host firewall is default-deny inbound with one blanket
allow on the tailnet interface ([Server-Setup-Runbook.md](Server-Setup-Runbook.md), "Open the firewall
to the tailnet"), which is how 19002, 19030 and 19099 are reachable too. Confirm that is still the
shape, from your admin login (not inside the `prod@` shell; ufw needs sudo):

```bash
sudo ufw status | grep -E 'Status|tailscale0'
```

Expected: `Status: active`, then `Anywhere on tailscale0 ALLOW Anywhere` (and its `(v6)` twin), with
no public allow for 19040. A per-port `ufw allow 19040` would expose it publicly; do not add one.

### 3.4 Deploy

Komodo → ResourceSync → refresh, review the diff (one new stack, `prod-dev-usage`), apply, then deploy
the stack. Then, from the dev container, a request **without** a token must be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://<tailnet-host>:19040/sessions?limit=1"
```

Expected: `401`. A `000` means the stack is not up or the dev container cannot reach the host (§3.5, network policy). A `200` would mean an anonymous
role exists, which it must not; stop and investigate.

### 3.5 The dev container's three values

In the Sandbox VM (`ssh mcm.sbx`), add to `~/.mcm-sandbox-env`. First the two URLs. They are topology,
not secrets, but are never committed:

```bash
cp ~/.mcm-sandbox-env ~/.mcm-sandbox-env.bak
printf 'MCM_USAGE_INGEST_URL=http://%s:19040\nMCM_USAGE_TOKEN_URL=http://%s:19099/realms/grumpyrobot/protocol/openid-connect/token\n' \
  "<tailnet-host>" "<tailnet-host>" >> ~/.mcm-sandbox-env
grep -c '^MCM_USAGE_' ~/.mcm-sandbox-env
```

Expected: `2`. Then the secret, as **one line on its own** (not part of a pasted block). Paste the
secret, press Enter. Nothing echoes:

```bash
{ printf 'MCM_USAGE_CLIENT_SECRET='; stty -echo; head -1; stty echo; } >> ~/.mcm-sandbox-env
```

Check without printing it:

```bash
grep -c '^MCM_USAGE_' ~/.mcm-sandbox-env; sed -n 's/^MCM_USAGE_CLIENT_SECRET=//p' ~/.mcm-sandbox-env | tr -d '\n' | wc -c
```

Expected: `3`, then the secret's length (32 for a Keycloak-generated secret). Recreate the container as
in [devcontainer-sandbox.md §2](devcontainer-sandbox.md) ("Recreating the DEV CONTAINER", with
`set -a; . ~/.mcm-sandbox-env; set +a` first). `gen-container-secrets-env.sh` carries the secret into
the `--env-file`, and the two URLs arrive through `containerEnv`.

**Sandbox network policy.** Both egress layers allow per **host**, not per port (research, spike
result (h)). If the two URLs use the forge host, nothing more is needed: it is already allowed. A
different host needs `sbx policy allow network <host> --sandbox mcm` on the Windows host **and** an
in-VM allowlist entry ([devcontainer-sandbox.md §4](devcontainer-sandbox.md)).

### 3.6 Confirm capture

In the new container, start any Claude Code session, then:

```bash
node scripts/cc-usage.mjs doctor
```

Expected after the first `SessionStart`: `configured: yes`, a `last ship` time, `token: valid until …`,
and `unshipped:` shrinking to `none` as the first sweep backfills the volume (about 170 MB, file by
file). Deploying this is what starts the two-week baseline the findings in US4 need.

### 3.7 Reinstall the host backup (prod host, after 3.4)

The host runs **copies** of the backup scripts, so the new dump step (`[6/9]`) does nothing until
they are reinstalled from the merged `main`: follow
[infrastructure-as-code/backup/README.md](../../infrastructure-as-code/backup/README.md) "Install or
update", step 3, exactly as written. Do it **after** the stack is up: the step dumps
`dev-usage-postgres`, and with that container missing it fails the whole run and raises a backup
alert. Then run one backup by hand rather than waiting for the timer. A whole run takes 8-10
minutes, so start it without blocking and poll for at most 20:

```bash
systemctl --user start --no-block homelab-backup.service
for i in $(seq 1 120); do systemctl --user is-active -q homelab-backup.service || break; sleep 10; done
systemctl --user show -p Result homelab-backup.service
journalctl --user -u homelab-backup --since '-30min' --no-pager | grep -E 'dev-usage: [0-9]+ bytes'
```

Expected: `Result=success`, then one `dev-usage: N bytes` line. A `Result=` other than `success`
also opens a backup alert in the backlog; the journal says which step failed.

## 4. `doctor`, line by line

| Line | Meaning | If wrong |
| --- | --- | --- |
| `configured: no (missing …)` | One of the three values is not in the container env | 3.5; recreate the container |
| `last ship: never` | Nothing has reached the store yet | Check the lines below |
| `spool: N files, K KB; drops: D` | Batches waiting for the store; `drops` were deleted at the 50 MB cap | Spool drains on the next ship once the store answers; the next sweep re-derives dropped ranges from transcripts still on the volume |
| `back-off: active until …` | The last network call failed; the hooks skip the network until then | Usually the store or Keycloak was unreachable; wait, or fix reachability |
| `token: valid until …` | A cached Keycloak token | — |
| `token: client credential rejected` | Keycloak refused the secret (400/401) | Secret wrong or rotated: redo 3.1 step 6 and 3.5 |
| `token: store rejects token` | Keycloak issued a token, but PostgREST refused it (401) | Almost always a signing-key rotation, see §5 |
| `unshipped: N transcripts — …` | Transcripts with bytes not yet shipped | Normal right after a session; persistent means the hooks are not running or are in back-off |

The structured log is `$CLAUDE_CONFIG_DIR/usage/cc-usage.log` (JSON lines, session id as correlation
id, capped at 1 MB and rotated once). It never holds a token or a host name.

## 5. Keycloak signing-key rotation

PostgREST reads the realm's public keys once, when it starts, from the file `dev-usage-jwks-init` fetched
(that init refetches on every deploy and every restart, then idles). After a rotation in Keycloak, new
tokens are refused until PostgREST restarts on fresh keys: **redeploy `prod-dev-usage`** in Komodo.
Meanwhile `doctor` shows `store rejects token` and capture spools. Nothing is lost while the spool and
the transcripts last.

## 6. CI

The `app-ci / dev-usage-integration` job runs `pnpm nx dev-usage-integration infrastructure-as-code` on
the `kvm` runner whenever a PR touches the store, the capture script or the realm files. It brings up
real Postgres, PostgREST and a throwaway Keycloak, runs the contract tests, and removes everything.
**Required check: not decided.** This feature does not change branch protection. After the job has
run green on a few PRs, decide whether to require it, and record the decision here.
(`node scripts/ci-status.mjs` reads the live required-check set.)

Run it locally the same way (needs Docker; about 3 minutes; leaves nothing behind):

```bash
MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code
```

## 7. Backup and restore

The nightly host backup dumps the database (`backup.sh` step 6, `dev-usage.dump`, `pg_dump -Fc`). To
restore into a running stack, on the prod host:

```bash
docker cp dev-usage.dump dev-usage-postgres:/tmp/dev-usage.dump
docker exec dev-usage-postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/dev-usage.dump'
docker exec dev-usage-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from usage.sessions"'
```

Expected: no errors from `pg_restore`, then a session count. Then redeploy the stack, so the schema
re-applies over the restored data (every schema file is idempotent).

## 8. When the transcript format drifts

A Claude Code upgrade can change transcript lines. The parser then marks sessions `partial` with reason
`format-drift` rather than storing zeros. To check:

1. `node scripts/cc-usage.mjs oracle-check`: the parser against the committed reference totals.
2. Query recent `partial` sessions and their `partial_reasons` (`GET /v_session_totals?capture_status=eq.partial`).
3. If the format changed: update the fixture generator
   (`scripts/__tests__/fixtures/cc-usage/generate-fixtures.mjs`) to the new shape, regenerate, run
   `pnpm nx cc-usage-oracle infrastructure-as-code` (it runs the pinned reference tool on demand, never
   in CI), fix the parser until `oracle-check` and the parser tests pass, and bump `PARSER_VERSION`.
