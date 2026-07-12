#!/usr/bin/env bash
# init-firewall.sh — feature 037 (containerized dev-env)
#
# Governing: FR-002 (network blast-radius reduction for the in-container agent), research D4
#            (Anthropic Claude Code reference: default-deny egress + allowlist).
#
# Default-DENY the dev container's OWN outbound traffic (OUTPUT chain), allowlisting only the
# destinations the workflow needs. This blocks a compromised dependency / agent process from
# exfiltrating to an arbitrary host, while git / pnpm / Claude Code / DinD image pulls keep
# working.
#
# Scope & honest limits (see docs/runbooks/devcontainer.md):
#   • Controls the dev container's egress AND the in-container dockerd's image pulls (both
#     originate in this netns → OUTPUT). Registry domains are allowlisted in the DinD section.
#   • Does NOT independently firewall the egress of *nested running containers* (their traffic
#     is FORWARD-ed + MASQUERADE-d by the DinD dockerd). We deliberately leave the FORWARD
#     chain to dockerd so nested-container networking is not broken (research D3/T015a). That
#     residual is documented, not hidden — consistent with the feature's honest-posture stance.
#   • CDN-backed registries (Docker Hub / ghcr.io) rotate IPs; this script resolves by DOMAIN
#     and is re-runnable (idempotent) so it can be re-invoked to refresh the ipset if a pull
#     starts failing mid-session (T015a).
#
# Must run as root (wired via a root lifecycle hook in devcontainer.json before dropping to
# `coder`). Re-running rebuilds the ruleset from scratch.

set -euo pipefail
IFS=$'\n\t'

if [ "$(id -u)" -ne 0 ]; then
  echo "init-firewall: must run as root" >&2
  exit 1
fi

echo "init-firewall: applying default-deny egress with allowlist"

# --- allowlist domains -------------------------------------------------------------------
# US1 core: Anthropic API (Claude Code), GitHub (git/clone), npm registry (pnpm/npm install).
# US2 (T014) appends the container-image registries DinD pulls from. The forge registry host
# is injected from the env var FORGE_REGISTRY_HOST (topology-scrub rule — never a git literal).
ALLOWED_DOMAINS=(
  "api.anthropic.com"
  "registry.npmjs.org"
  "github.com"
  "api.github.com"
  "codeload.github.com"
  "objects.githubusercontent.com"
  "raw.githubusercontent.com"
  # US2 (T014) — container-image registries the in-container dockerd pulls from for compose
  # stacks / integration tests. Without these, `docker pull` inside the container fails and the
  # allowlist is the FIRST suspect (data-model invariant). These CDN-backed hosts rotate IPs;
  # this script resolves by domain and is re-runnable to refresh the ipset (T015a).
  "registry-1.docker.io"
  "auth.docker.io"
  "index.docker.io"
  "production.cloudflare.docker.com"
  "production.cloudfront.docker.com"
  "ghcr.io"
  "pkg-containers.githubusercontent.com"
)

# The project's forge registry host is topology-sensitive — NEVER a git literal (topology-scrub
# gate). Inject it at runtime via FORGE_REGISTRY_HOST (set in the gitignored devcontainer env /
# remoteEnv). Skip cleanly when unset — no literal, no fallback (secrets-management rule).
if [ -n "${FORGE_REGISTRY_HOST:-}" ]; then
  ALLOWED_DOMAINS+=("${FORGE_REGISTRY_HOST}")
  echo "init-firewall: forge registry host allowlisted from env"
else
  echo "init-firewall: FORGE_REGISTRY_HOST unset — forge registry NOT allowlisted (set it to pull from the forge)"
fi

# --- reset -------------------------------------------------------------------------------
# Reset INPUT/OUTPUT policy to ACCEPT FIRST: `iptables -F` clears rules but NOT the default
# policy, so a leftover DROP from a prior run would block this script's own DNS/HTTPS setup
# traffic on re-run (the runbook tells users to re-run to refresh stale registry IPs).
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -F
iptables -X 2>/dev/null || true
# NOTE: we intentionally do NOT flush the `nat` table or touch the FORWARD policy — those are
# owned by the in-container dockerd (DinD). Clobbering them breaks nested-container networking.

ipset destroy allowed-domains 2>/dev/null || true
ipset create allowed-domains hash:net family inet

# --- baseline connectivity (added BEFORE the DROP policy) --------------------------------
# Loopback (covers Docker embedded DNS at 127.0.0.11 reached via lo).
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# DNS resolution (needed by everything below, incl. this script's own dig calls).
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Stateful return traffic.
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Host / docker-bridge subnet: keep VS Code server + dev-server port-forwarding reachable.
HOST_NET="$(ip -o route show to default 2>/dev/null | awk '{print $3}' | head -1 || true)"
if [ -n "${HOST_NET}" ]; then
  HOST_CIDR="$(ip -o route | awk -v g="${HOST_NET}" '$0 ~ g" " {print $1; exit}')"
  if [ -n "${HOST_CIDR}" ] && [ "${HOST_CIDR}" != "default" ]; then
    iptables -A INPUT  -s "${HOST_CIDR}" -j ACCEPT
    iptables -A OUTPUT -d "${HOST_CIDR}" -j ACCEPT
    echo "init-firewall: allowed host/bridge subnet ${HOST_CIDR}"
  fi
fi

# --- resolve allowlist domains into the ipset --------------------------------------------
add_domain() {
  local domain="$1" ip
  # A records; de-dup; skip empties.
  for ip in $(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'); do
    ipset add allowed-domains "$ip" 2>/dev/null || true
  done
}

for d in "${ALLOWED_DOMAINS[@]}"; do
  add_domain "$d"
done

# GitHub publishes its egress CIDR ranges via its meta API — allowlist the git/web/api/packages
# ranges as networks so clone/fetch survives GitHub IP churn. Falls back to A-record resolution
# above if the meta fetch fails.
if meta="$(curl -fsS --max-time 10 https://api.github.com/meta 2>/dev/null)"; then
  echo "$meta" | jq -r '(.git + .web + .api + .packages)[]? ' 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' \
    | while read -r cidr; do ipset add allowed-domains "$cidr" 2>/dev/null || true; done
  echo "init-firewall: added GitHub meta CIDR ranges"
else
  echo "init-firewall: WARN github.com/meta unreachable — relying on A-record allowlist only" >&2
fi

# --- registry CDN ranges (OPT-IN T015a fallback) -----------------------------------------
# Docker Hub serves blob layers from the STABLE hostnames production.cloudfront.docker.com /
# production.cloudflare.docker.com (allowlisted as domains above) — that tight default was the
# actual fix for the failing pull and is sufficient in the common case.
#
# Only if you hit REPEATED stale-IP pull failures (a CDN round-robins to an IP the A-record
# snapshot missed) set FIREWALL_ALLOW_CDN_RANGES=1 to ALSO allowlist the CDN providers' published
# CIDR ranges. This is a BROAD, deliberate widening (opens egress to the whole AWS-CloudFront +
# Cloudflare edge networks) and is OFF by default to keep the default-deny meaningful. The
# primary control is strong host-FS/credential isolation; this firewall is defence-in-depth.
if [ "${FIREWALL_ALLOW_CDN_RANGES:-}" = "1" ]; then
  add_cidrs() {  # $1=url  $2=jq-filter-or-empty  $3=label
    local url="$1" filter="$2" label="$3" body n=0
    if body="$(curl -fsS --max-time 15 "$url" 2>/dev/null)"; then
      if [ -n "$filter" ]; then body="$(echo "$body" | jq -r "$filter" 2>/dev/null)"; fi
      while read -r cidr; do
        [ -n "$cidr" ] && ipset add allowed-domains "$cidr" 2>/dev/null && n=$((n+1))
      done < <(echo "$body" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$')
      echo "init-firewall: added $n $label CIDR ranges (FIREWALL_ALLOW_CDN_RANGES=1)"
    else
      echo "init-firewall: WARN could not fetch $label ranges ($url)" >&2
    fi
  }
  add_cidrs "https://ip-ranges.amazonaws.com/ip-ranges.json" \
    '.prefixes[] | select(.service=="CLOUDFRONT") | .ip_prefix' "AWS-CloudFront"
  add_cidrs "https://www.cloudflare.com/ips-v4" "" "Cloudflare"
fi

# Allow egress to any allowlisted destination.
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# --- default-deny ------------------------------------------------------------------------
# INPUT + OUTPUT default DROP. FORWARD is left to dockerd (see header note).
iptables -P INPUT  DROP
iptables -P OUTPUT DROP

echo "init-firewall: default-deny egress active ($(ipset list allowed-domains | grep -c '^[0-9]') allowlisted entries)"
