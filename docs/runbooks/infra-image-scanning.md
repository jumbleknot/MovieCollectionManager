# Infra-Image CVE Scanning (feature 035)

Keyless, config-as-code vulnerability scanning of the **third-party server images the project pulls but does not build** — the coverage gap left by the other scanners. Complements, does not overlap, the existing gates.

## What it covers (and what it doesn't)

| Scanner | Layer | Scans |
|---|---|---|
| SAST/SCA (033) | at-rest source + **our** deps | Semgrep + cargo/pnpm/pip-audit over first-party code + our dependency graphs |
| DAST (031) | running app HTTP | OWASP ZAP against the live BFF / mc-service / gateway |
| `cd-deploy` Trivy (023) | **our built images** | the 6 `jumbleknot/*` images we build + push |
| **Infra-image scan (035)** | **pulled third-party images** | Keycloak, Postgres, Redis, Mongo, Vault, OpenSearch, ClickHouse, LangFuse, Grafana, OPA, Unleash, MinIO, Caddy, Mailpit — everything in `infrastructure-as-code/**` **except** the 6 built images and `${..}`-interpolated refs |

The 035 set and the `cd-deploy` set are **disjoint** (enforced by a unit test). Renovate keeps base images *current*; this scan detects a **published CVE against an already-pinned image**, which currency alone misses.

## How it runs

- **Weekly full sweep** (`schedule: cron '0 7 * * 5'` (Friday 07:00 UTC ≈ 3 AM ET)) — the authoritative run. A new advisory can hit an **unchanged** pinned image, so the sweep is **not path-gated** (same rule as the 033 SCA scan).
- **On-change PR/push check** — `.forgejo/workflows/infra-image-scan.yml` also triggers when `infrastructure-as-code/**`, the scanner scripts, or `security/infra-images/**` change, for fast feedback on a newly-introduced vulnerable image.
- **Keyless** (public images, Trivy fetches advisory data with no account — no `${{ secrets }}`) and **fail-closed** (a Trivy/pull/parse failure fails the job — never a clean report on failure).

## Local use (where Trivy is available)

Trivy is **not** on the Windows dev box — the authoritative scan is the Linux/CI job. On a Linux/WSL/macOS host with Trivy + Docker:

```bash
# Enumerate only (works ANYWHERE, no Trivy — confirm coverage)
node scripts/infra-image-scan.mjs --list
#   equivalently: pnpm nx infra-scan infrastructure-as-code -- --list

# Full scan → security/infra-images/reports/{findings.json,summary.txt,trivy-*.json}
node scripts/infra-image-scan.mjs            # add --emit-allowlist to also write allowlist.proposed.yaml
pnpm nx infra-scan infrastructure-as-code

# Gate: fail on any un-allowlisted FIXABLE High/Critical
node scripts/check-infra-image-findings.mjs
node scripts/check-infra-image-findings.mjs --selftest   # prove fail/suppress/expiry without Trivy

# Unit tests (pure enumeration + normalization — Windows-friendly)
node --test scripts/__tests__/infra-image-scan.test.mjs
```

## The gate

`blocking = FIXABLE High/Critical` (a `FixedVersion` exists upstream). Unfixable High/Critical and all Medium/Low are **report-only warnings** — a bump can't clear an unfixable CVE, so it must not wedge the gate (same intent as `cd-deploy`'s `--ignore-unfixed`). The gate fails on any blocking finding not covered by a **live** (non-expired) allowlist entry.

## Allowlist-as-baseline (`security/infra-images/allowlist.yaml`)

The allowlist **is** the accepted baseline — suppression is gate-only; findings stay visible in `findings.json`. Entry shape:

```yaml
- image: 'quay\.io/keycloak/.*'   # regex vs the scanned repo:tag
  id: 'CVE-2026-1234'             # regex vs advisory id
  justification: 'awaiting Renovate bump to keycloak:26.6.0'
  addedBy: 'steve'
  expiry: '2026-09-01'           # optional; past-expiry stops suppressing (forces re-triage)
```

All four of `image`/`id`/`justification`/`addedBy` are required; a blank field or invalid regex is a gate error.

### Seeding the baseline (first landing — on CI)

Trivy isn't local, so seed from the **first Linux/CI scan** (feature-033 platform lesson):

1. Land with an **empty** allowlist. The CI job runs `--emit-allowlist`, writing `security/infra-images/reports/allowlist.proposed.yaml` (every current blocking finding as a ready-to-paste entry).
2. Retrieve the report from the CI run (the reports dir is gitignored; pull it from the runner — the artifact is uploaded as `infra-image-scan-report`, or read it from the runner workspace over SSH).
3. Triage each blocking finding into `security/infra-images/allowlist.yaml` (justification referencing the responsible base-image bump; `expiry` where a bump is imminent).
4. Re-run the gate → green. Every entry maps to a real, still-visible finding (no phantom suppressions).

## Remediation (Renovate owns it)

A finding is fixed by a **Renovate base-image bump** (bump the pinned tag/digest). After the bump lands and the scan re-runs, **delete** the finding's allowlist entry — the gate stays green and a regression re-blocks. The scan does not bump anything itself.

## Operator: make it a required check

The **PR-triggered** `infra-image-scan` context should be added to `main` branch protection as a required check (Forgejo → repo → Settings → Branches). The **weekly** run is a scheduled safety net — its failure surfaces on the Actions list (wire an alert/issue if desired); it is not a PR gate. The agent cannot self-configure branch protection — this is a manual operator step.
