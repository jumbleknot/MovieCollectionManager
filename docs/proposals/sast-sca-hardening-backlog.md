# SAST / SCA Hardening Backlog

> **STATUS — REMEDIATED in feature 034 (branch `034-hardening`).** The allowlist burned down
> **24 → 4 entries** (the 4 remaining are the FR-010 false-positive/accepted-risk keep-list). Blocking
> findings **55 → 24** (the 24 are all keep-list, gate green). Per-workstream outcome:
> - **P1 runtime dep CVEs — DONE.** All 18 runtime SCA advisories cleared by lockfile bumps (Python
>   7 pkgs via `uv.lock`, JS form-data/hono/undici via `pnpm.overrides`, Rust crossbeam-epoch). All 18
>   allowlist entries deleted; a fresh scan shows zero blocking SCA findings.
> - **P2 non-root containers — DONE.** All 5 app-tier Dockerfiles now set a non-root `USER`
>   (`dockerfile.security.missing-user` → 0; entry deleted). Verified: BFF uid=100, MCP uid=999.
> - **P3 CI/CD supply-chain — DONE.** 40 action refs SHA-pinned (`mutable-action-tag` → 0), release-age
>   cooldowns added (Renovate/pnpm/npm), all 6 `run-shell-injection` steps refactored to `env:` vars
>   (→ 0; entry deleted).
> - **P4 dev-deps — DEFERRED to Renovate (non-blocking, FR-008).** JS overrides didn't apply via
>   lockfile-only (would need a risky full re-install of shared minimatch/picomatch/esbuild);
>   `quick-xml` is capped by an upstream parent range (fix 0.41.0 outside `^0.40`). Left as
>   non-blocking warnings; the new Renovate cooldown + `vulnerabilityAlerts` will bump them.
>
> The remainder of this document is the original 033 worklist, retained for provenance.

**Source**: the feature-033 baseline scan (`node scripts/sast-scan.mjs --scope full`), 2026-07-11.
**Purpose**: input for a follow-up **hardening feature branch**. Every item below is currently
**allowlisted** in [`security/sast/allowlist.yaml`](../../security/sast/allowlist.yaml) (so `main` is
green) — this document is the remediation worklist to burn that baseline down. As each item is fixed,
**remove its allowlist entry** so a regression re-blocks.

> These were all **pre-existing** when 033 landed — 033 only *detects and gates*; it fixed nothing in
> app code (spec FR-012). None were introduced by the SAST feature.

Scan totals: **145 findings / 55 blocking**. Nothing in first-party code needed an urgent fix — the
custom MCM invariant rules (`mcm-no-token-logging`, `mcm-auth-before-authz`, `mcm-no-jwt-payload-tracing`)
found **zero real violations** (all hits were test-file false positives). The real signal is
**dependency CVEs** and **infra/CI hardening**.

---

## P1 — Runtime dependency CVEs (19 advisories, 13 packages) — HIGH priority

Known-vuln advisories on **production-reachable** dependencies. All have a fixed version available.
Remediation = version bumps (Renovate should propose these; some are transitive and need a lockfile
update). These are the reason to prioritize the branch.

### Python (agent layer — `agents/movie-assistant`, `uv.lock`)

| Package | Current | Fix | Advisories |
|---|---|---|---|
| `aiohttp` | 3.14.0 | **3.14.1** | PYSEC-2026-237, CVE-2026-54273/54274/54276/54277/54278/54279/54280 (8) |
| `cryptography` | 48.0.0 | **48.0.1** | GHSA-537c-gmf6-5ccf |
| `langchain` | 1.3.4 | **1.3.9** | CVE-2026-55443 |
| `langchain-anthropic` | 1.4.4 | **1.4.6** | CVE-2026-55443 |
| `langsmith` | 0.8.9 | **0.8.18** | CVE-2026-59152 |
| `pydantic-settings` | 2.14.1 | **2.14.2** | CVE-2026-58203 |
| `starlette` | 1.2.1 | **1.3.1** | PYSEC-2026-248 (fix 1.3.0), PYSEC-2026-249 (fix 1.3.1) |

### JavaScript (root `pnpm-lock.yaml`)

| Package | Current | Fix | Advisory |
|---|---|---|---|
| `form-data` | 4.0.5 | **≥4.0.6** | GHSA-hmw2-7cc7-3qxx (CRLF injection via unescaped multipart field name) |
| `hono` | 4.12.23 | **≥4.12.25** | GHSA-88fw-hqm2-52qc (CORS reflects any Origin with credentials) |
| `undici` | 6.26.0 | **≥6.27.0** | GHSA-vxpw-j846-p89q (WebSocket DoS via fragment concatenation) |

### Rust (root `Cargo.lock`)

| Package | Current | Fix | Advisory |
|---|---|---|---|
| `crossbeam-epoch` | 0.9.18 | **≥0.9.20** | RUSTSEC-2026-0204 (invalid pointer deref in `fmt::Pointer`) — transitive |

**Remediation notes**: bump via Renovate where possible; for transitive-only deps (`crossbeam-epoch`,
some Python) a `cargo update -p <pkg>` / `uv lock --upgrade-package <pkg>` may be needed. After each bump,
rebuild + re-run `pnpm nx sast infrastructure-as-code` and drop the corresponding allowlist entry.

---

## P2 — Container images run as root (5 Dockerfiles) — MEDIUM priority

`dockerfile.security.missing-user` — these images never drop to a non-root `USER`. `backend/mc-service`
already does it right (use it as the reference pattern).

- `frontend/mcm-app/Dockerfile` (BFF / Expo server)
- `agents/movie-assistant/Dockerfile` (agent gateway)
- `mcp-servers/movie-mcp/Dockerfile`
- `mcp-servers/spreadsheet-mcp/Dockerfile`
- `mcp-servers/web-api-mcp/Dockerfile`

**Remediation**: add a dedicated non-root user + `USER` before `CMD` (mind file ownership of any
writable paths / caches). They currently run only on the trusted internal Docker network, so this is
defense-in-depth, not an active exposure.

---

## P3 — CI/CD & supply-chain hardening — MEDIUM priority

### Pin GitHub/Forgejo actions to commit SHAs (40 findings)

`github-actions-mutable-action-tag` — actions are referenced by mutable tags (`@v4`), which can be
re-pointed upstream. Pin to full commit SHAs across `.forgejo/workflows/*.yml` (`actions/checkout`,
`pnpm/action-setup`, `actions/setup-node`, `astral-sh/setup-uv`, `actions/upload-artifact`, …).

### Review `run:` steps for shell injection (6 findings, currently allowlisted High)

`run-shell-injection` in `app-ci.yml` + `cd-deploy.yml` — `${{ … }}` interpolated directly into shell.
Triage each: confirm the interpolated value is a trusted internal output/secret (not attacker-controlled
PR input); where feasible, pass via `env:` and reference `"$VAR"` instead of inlining the expression.

### Package-manager supply-chain policy (Medium, non-blocking today)

- **Renovate `minimumReleaseAge`** (`renovate.json`, 3 findings) — add a cooldown so brand-new releases
  aren't auto-merged (mitigates a compromised-release window). Ties into the P1 bump workflow.
- **pnpm** (`pnpm-workspace.yaml`) — `pnpm-trust-policy`, `pnpm-minimum-release-age`,
  `pnpm-block-exotic-sub-dependencies`: consider a trust policy + minimum release age + blocking exotic
  (git/http) sub-deps.
- **npm** (`.npmrc`) — `npm-missing-minimum-release-age`.

### `curl | sh` installers (7 findings, currently allowlisted)

`gha-curl-pipe-shell` — the uv/rustup bootstrap. Accepted (pinned vendor URLs). Optional hardening:
checksum-pin the installer, or use a pinned toolchain action instead of piping to a shell.

### Secrets referenced in workflow `env:` (2 findings)

`gha-workflow-env-secret` in `app-ci.yml` / `cd-deploy.yml` — review that secrets exposed as step `env`
are minimally scoped.

---

## P4 — Dev / build-only dependency CVEs (22 advisories) — LOW priority

Not runtime-reachable (test/build/tooling deps), so **non-blocking** — but still worth bumping opportunistically.

| Package | Current | Fix | Notes |
|---|---|---|---|
| `undici` | 7.24.7 | **≥7.28.0** | 7 advisories (dev copy; the 6.26.0 runtime copy is P1) |
| `vite` | 8.0.14 | **≥8.0.16** | 2 advisories |
| `ws` | 8.18.0 | **≥8.21.0** | GHSA-96hv-2xvq-fx4p, GHSA-58qx-3vcg-4xpx |
| `minimatch` | 9.0.3 | **≥9.0.7** | 3 ReDoS advisories |
| `picomatch` | 4.0.2 | **≥4.0.4** | 2 advisories |
| `http-proxy-middleware` | 3.0.5 | **≥3.0.7** | 2 advisories |
| `esbuild` | 0.27.7 | **≥0.28.1** | GHSA-g7r4-m6w7-qqqr |
| `tmp` | 0.2.6 | **≥0.2.7** | GHSA-7c78-jf6q-g5cm |
| `quick-xml` (Rust dev) | 0.40.1 | **≥0.41.0** | RUSTSEC-2026-0194/0195 |

---

## Verified false positives / accepted (NO action — keep allowlisted, documented)

- `javascript…gcm-no-tag-length` — `agent-config-crypto.ts:57`: AES-256-GCM tag is a fixed 16 bytes,
  sliced + verified via `setAuthTag()`; Node defaults to 128-bit. Safe.
- `…bypass-tls-verification` — `audit-sink.ts:85`: `rejectUnauthorized:false` is **opt-in behind
  `OPENSEARCH_INSECURE_TLS`** and scoped to one request (dev self-signed OpenSearch). Optional follow-up:
  pin a CA instead so the escape hatch can't be enabled in prod.
- `python…logger-credential-disclosure` — `token_exchange.py:101`: logs **status code only** (explicitly
  never the token/body, SC-004). Safe.
- `mcm-no-token-logging` / `mcm-auth-before-authz` (16 hits) — all in `src/bff-server/unit-tests/**`;
  tests deliberately exercise the pattern. Not production code.
- `mcm-no-console-in-bff` — `logger.ts:61` (2 hits, Medium): the structured logger's own transport writes
  to `console`. Expected.

---

## Suggested branch shape

Split by risk/ownership so reviews stay focused:

1. **US1 — runtime dependency bumps (P1)**: Python + JS + Rust runtime CVEs. Highest value. Verify each
   with the SAST gate + the app/agent test suites; drop allowlist entries as they clear.
2. **US2 — container non-root hardening (P2)**: `USER` in the 5 Dockerfiles; re-run app + agent E2E.
3. **US3 — CI/CD supply-chain (P3)**: pin action SHAs, Renovate/pnpm/npm release-age policy, triage the
   `run-shell-injection` steps.
4. **(optional) US4 — dev-dep bumps (P4)**: opportunistic, low risk.

Each cleared finding = one deleted `allowlist.yaml` entry. Track the burn-down against
`node scripts/check-sast-findings.mjs` staying green.
