# Contract: canonical egress destination list

**Feature**: 060-devcontainer-docker-sandbox | **Governing**: FR-007, FR-008, FR-011 | **Risk closed**: R8

One list, two consumers, no hand-maintained copies. This contract fixes the file shape and the generator's output so the two enforcement layers cannot diverge.

## Source of truth

`.devcontainer/egress-allowlist.json`

```jsonc
{
  "$comment": "Canonical egress destinations. Consumed by scripts/gen-egress-policy.mjs, which emits BOTH the sandbox network policy and the in-VM firewall domain array. Never hand-edit either emitted form. The forge host is NOT in this file — it is injected at runtime (see below).",
  "destinations": [
    {
      "domain": "api.anthropic.com",
      "group": "agent",
      "reason": "Claude Code + the agent gateway's model backend; golden cassette re-record path.",
      "cdnRotating": false
    },
    {
      "domain": "production.cloudfront.docker.com",
      "group": "registry",
      "reason": "Docker Hub blob layers. CloudFront-backed; rotates IPs faster than a one-shot A-record ipset can track.",
      "cdnRotating": true
    }
    // … remaining entries migrated verbatim from init-firewall.sh, reasons preserved
  ]
}
```

### Field contract

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `domain` | string | yes | FQDN. **Never a bare IP** — CDN-backed hosts rotate, and the list is resolved by domain and re-runnable. |
| `group` | enum | yes | `agent` \| `source` \| `registry` \| `packages` \| `app` |
| `reason` | string | yes | Non-empty. An unexplained allowlist entry is an unreviewable one. |
| `cdnRotating` | boolean | yes | `true` marks the ipset-staleness class — the entries whose blob timeouts are a re-resolve, not a missing rule. |

### What must never appear in this file

- The forge / registry host, or any tailnet address. Topology-sensitive, gated out of git; injected at runtime from `FORGE_REGISTRY_HOST` exactly as today. The generator takes it as a **parameter**.
- Any credential, token or key.
- The OpenWiki analytics host. Telemetry is disabled **by configuration** (`OPENWIKI_TELEMETRY_DISABLED=1`), never by allowlisting the destination. This inversion is deliberate and must survive the migration.

### Entries migrated from the current script

All present entries carry forward with their recorded reasons. Groups, for the generator:

| Group | Entries |
| --- | --- |
| `agent` | `api.anthropic.com` |
| `source` | `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com` |
| `registry` | `registry-1.docker.io`, `auth.docker.io`, `index.docker.io`, `production.cloudflare.docker.com`, `production.cloudfront.docker.com`, `ghcr.io`, `pkg-containers.githubusercontent.com`, `quay.io`, `cdn.quay.io`, `cdn01.quay.io`, `cdn02.quay.io`, `cdn03.quay.io` |
| `packages` | `registry.npmjs.org`, `crates.io`, `static.crates.io`, `index.crates.io`, `pypi.org`, `files.pythonhosted.org`, `astral.sh`, `api.expo.dev`, `exp.host` |
| `app` | `api.themoviedb.org` |

`api.themoviedb.org` carries a subtle reason that must not be lost in the move: it is allowlisted **for the test runner**, not for the app. Every runtime path that calls TMDB is a container and traversed the FORWARD chain, which the in-VM firewall leaves alone. Under sandbox policy that distinction disappears — the policy governs siblings too — so the entry is now required for *both*, and the reason text must be updated to say so rather than silently inheriting stale wording.

## Generator contract

`scripts/gen-egress-policy.mjs`

```text
Usage:
  node scripts/gen-egress-policy.mjs --format sbx-policy   [--forge-host <host>]
  node scripts/gen-egress-policy.mjs --format ipset-domains [--forge-host <host>]
  node scripts/gen-egress-policy.mjs --check
```

| Mode | Output | Consumer |
| --- | --- | --- |
| `--format sbx-policy` | one `allow network <domain>` directive per destination, on stdout | applied to the sandbox by the P2 policy step |
| `--format ipset-domains` | newline-separated domains, on stdout | sourced by `init-firewall.sh` in place of its inline array |
| `--check` | exit 0 if the file satisfies every field rule above; exit 1 with the offending entry named | committed-clean / CI gate |

**Behaviour rules**

1. `--forge-host` is optional. When absent, the forge entry is **omitted cleanly** — no literal, no fallback, no error. This mirrors the current script's behaviour exactly (unset → skip, container still comes up).
2. Output is deterministic and stably ordered, so a regenerated form produces an empty diff when nothing changed.
3. The generator never writes files by default. Emitted forms are piped by their consumer, so there is no generated artifact to fall stale in git.
4. `--check` must fail on: a bare IP, an empty `reason`, an unknown `group`, or a destination that looks topology-sensitive.

## Consumer contract: `init-firewall.sh`

The inline `DOMAINS=(...)` array is replaced by a read of the generator's `ipset-domains` output. Everything else in the script is unchanged — the reset order, the "flush only our own chains, never `-X`" rule that stops dockerd's user chains being deleted, the RFC1918 bridge allows, and the re-runnable ipset refresh.

Its header comment must be corrected on one point of fact: under `--network=host` the script now programs the **VM's** OUTPUT chain, so it filters dockerd's image pulls as well. And the honest-limits paragraph stating it "does NOT independently firewall the egress of nested running containers" must be rewritten — that residual is now covered by the sandbox policy, and leaving the old wording in place would misdescribe the posture in the direction of *understating* it, which is its own kind of wrong.

## Verification contract

`verify-firewall-allowlist.sh` reads `egress-allowlist.json` and asserts the live ruleset matches it. It must **not** re-list domains inline — a check with its own copy of the expectation cannot detect drift in the thing it is checking.

Two-layer proof (FR-025 / G5):

| Probe | From | Expected |
| --- | --- | --- |
| allowlisted destination | dev-container shell | reachable |
| non-allowlisted destination (`example.com`) | dev-container shell | refused **+ audit entry** |
| non-allowlisted destination | **inside a sibling container** | refused **+ audit entry** ← the closed residual |
| workstation loopback service | dev-container shell | unreachable |

The third row is the one that did not exist before and is the security payoff of the whole feature. It must be a real probe from a real sibling, not an inference from the policy's stated scope.
