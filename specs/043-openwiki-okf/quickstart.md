# Quickstart: Validating the OKF Knowledge Layer

**Feature**: 043-openwiki-okf · **Date**: 2026-07-26

Runnable validation for this feature. Rules and field semantics are in
[data-model.md](./data-model.md); CLI behavior is in
[contracts/check-openwiki-okf-cli.md](./contracts/check-openwiki-okf-cli.md). Nothing is duplicated here.

---

## Prerequisites

- Dev container (`echo $MCM_DEVCONTAINER` → `1`). Node ≥ 22 — the container has v24.18.0.
- `ANTHROPIC_API_KEY` present in the environment (already passed through; verify with
  `[ -n "$ANTHROPIC_API_KEY" ] && echo ok`).
- **No** Docker stack, database, or running service is required. This feature touches no service.

---

## 1. Gate tests (fastest — run on every edit)

```bash
node --test scripts/__tests__/check-openwiki-okf.test.mjs
```

Expected: all fixture cases pass. Each rule V1–V13 has a fixture; a rule with no failing fixture
before implementation is a TDD violation, not a shortcut.

## 2. Gate selftest, then the real bundle

House order — selftest first, always:

```bash
node scripts/check-openwiki-okf.mjs --selftest   # exit 0 = detection logic intact
node scripts/check-openwiki-okf.mjs              # exit 0 = bundle conformant
```

Before the first generation run, step 2 **correctly exits 1** (`no bundle at openwiki/`). That is
fail-closed working as specified, not a setup error.

Verify the offline guarantee explicitly — it is the reason the CI job stays keyless:

```bash
unshare -rn node scripts/check-openwiki-okf.mjs   # no network namespace; must still exit 0
```

## 3. Generate or update the bundle

```bash
pnpm nx wiki-update infrastructure-as-code
```

The target sets `OPENWIKI_PROVIDER=anthropic` and `OPENWIKI_TELEMETRY_DISABLED=1` itself, then runs
`openwiki code --update --print`. **Always go through the target** — invoking the CLI directly on the
Windows host bypasses the telemetry opt-out, which is the whole reason the wrapper exists.

`--update` creates the bundle when none exists, so the interactive `--init` is never needed and no
`~/.openwiki/.env` is written. Author `openwiki/INSTRUCTIONS.md` **before** the first run — it is
hand-authored and the tool will not overwrite it.

**Expected**: `openwiki/` appears with per-directory `index.md`, a `log.md`, and concept files; and
`CLAUDE.md` / `AGENTS.md` each gain an `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block.

## 4. Prove telemetry is off (SC-013)

```bash
pnpm nx wiki-update infrastructure-as-code --args=--telemetry-file=/tmp/ow-telemetry.json

test -s /tmp/ow-telemetry.json && echo "FAIL: payload written" || echo "PASS: nothing to send"
```

Then confirm the opt-out is structural rather than incidental:

```bash
git diff --quiet .devcontainer/init-firewall.sh && echo "PASS: allowlist unchanged"
grep -q "OPENWIKI_TELEMETRY_DISABLED" infrastructure-as-code/project.json && echo "PASS: target sets it"
```

The allowlist must be untouched — disabling is by configuration, never by widening egress. Note the
container firewall would block the analytics host anyway; the host workspace has no such protection,
which is exactly why the check is on the target and not the firewall.

## 5. Leak gates before any bundle commit

```bash
node scripts/check-topology-scrub.mjs --selftest && node scripts/check-topology-scrub.mjs
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
```

A hit is fixed in `openwiki/INSTRUCTIONS.md` followed by regeneration. **Never** add an allowlist
entry (FR-012) — that converts a leak into a permanently accepted one.

## 6. Managed-block review (do not skip)

```bash
grep -n "nx configuration start\|nx configuration end\|SPECKIT START\|SPECKIT END\|OPENWIKI:START\|OPENWIKI:END" CLAUDE.md
```

**Expected**: the `OPENWIKI` block sits entirely **after** `<!-- SPECKIT END -->` and never interleaves
with the Nx block. Confirm with `git diff CLAUDE.md` that no existing line was deleted — FR-022 allows
additions and the one shell-line correction, nothing else.

## 7. CI-side gates

```bash
node scripts/check-ci-digest-coverage.mjs --selftest && node scripts/check-ci-digest-coverage.mjs
```

**Expected**: passes with the new `okf` job present. If it fails, the job is missing its
`Publish failure digest` step — that gate exists precisely to catch a new job added without one.

## 8. Full validation (before marking complete)

Required for every feature, no deviation for this one:

```bash
pnpm nx lint mcm-app
pnpm nx typecheck mcm-app
pnpm nx test mcm-app
pnpm nx test mc-service
```

Web E2E cannot run natively here — Chromium is uninstallable behind the egress allowlist. Run it in
the Playwright container with `--network host`, per
[docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md).

---

## Acceptance evidence to capture

Per FR-029, record in this folder's evidence document as you go — not reconstructed afterwards:

- **SC-003** — the eight retrieval questions and which concepts resolved each (≤ 2 files opened).
- **SC-004** — the ten concepts audited against their cited sources, with outcomes and any corrections.
- **SC-013** — the empty telemetry payload result from step 4.
- **Calibration** — the first generation's cost and a note on page quality (the one unknown the
  research deliberately left open).
