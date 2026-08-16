#!/usr/bin/env bash
# init-firewall.sh — feature 037 (containerized dev-env); allowlist extracted in feature 060
#
# Governing: FR-002 (network blast-radius reduction for the in-container agent), research D4
#            (Anthropic Claude Code reference: default-deny egress + allowlist),
#            060 FR-007 (one canonical destination list, every enforcement config derived from it).
#
# Default-DENY outbound traffic on the OUTPUT chain, allowlisting only the destinations the
# workflow needs. This blocks a compromised dependency / agent process from exfiltrating to an
# arbitrary host, while git / pnpm / Claude Code / image pulls keep working.
#
# Scope & honest limits (see docs/runbooks/devcontainer.md and docs/runbooks/devcontainer-sandbox.md):
#   • Controls the egress of whatever netns it runs in, AND that netns's dockerd image pulls.
#     THE SCOPE OF "THAT NETNS" CHANGED IN FEATURE 060 and is the thing to get right here:
#       – Docker Desktop path (037/038, retained): this runs inside the privileged dev container,
#         so OUTPUT covers the dev container's own traffic plus the NESTED dockerd's pulls.
#       – Sandbox path (060): the dev container joins the sandbox VM's network namespace
#         (`--network=host`, where "host" is the microVM). OUTPUT is therefore the VM's OUTPUT
#         chain, and now also filters the SANDBOX dockerd's image pulls. The registry entries in
#         the allowlist remain necessary for exactly the same structural reason, one level out.
#   • This script deliberately leaves the FORWARD chain to dockerd, so it does not itself police
#     container-to-internet traffic — doing so would break container networking (research
#     D3/T015a). Where that traffic IS policed depends on the topology, and under feature 060 it
#     is policed: the Docker Sandbox network policy is enforced HOST-SIDE, outside the microVM,
#     and governs ALL VM egress including every sibling container. That is the primary control;
#     this script is defence-in-depth beneath it. On the retained Docker Desktop path no such
#     outer layer exists, which is the residual that motivated the migration.
#   • Triage order when a request is blocked (two layers, one canonical list): check
#     `sbx policy log` FIRST, then reach for the in-VM ipset-staleness reflex below. Without a
#     stated order the two layers cost more diagnosis time than they save (research R8/D-05).
#   • CDN-backed registries (Docker Hub / ghcr.io / quay's Akamai shards) rotate IPs; this script
#     resolves by DOMAIN and is re-runnable (idempotent) so it can be re-invoked to refresh the
#     ipset if a pull starts failing mid-session (T015a). Entries in that class are flagged
#     `cdnRotating: true` in the canonical list.
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
# Feature 060 (FR-007): the destination list is no longer inlined here. It lives in
# .devcontainer/egress-allowlist.json — the single canonical list — and is read through
# scripts/gen-egress-policy.mjs, which emits the SAME list to the host-side sandbox network
# policy. Two enforcement layers with two hand-maintained lists turn a blocked fetch into the
# union of two allowlists and diagnosis into guesswork (research R8/D-04); one file prevents it.
#
# Each entry's recorded reason (why a CDN host rotates, why quay needs four Akamai shards, why
# TMDB is listed at all) moved WITH it into that file. Read it there before adding anything.
#
# The forge registry host is still injected at runtime from FORGE_REGISTRY_HOST and is NEVER a
# git literal (topology-scrub rule) — it is passed to the generator, not stored in the list.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="${REPO_ROOT}/scripts/gen-egress-policy.mjs"

if [ ! -f "${GEN}" ]; then
  echo "init-firewall: FATAL — ${GEN} not found; refusing to apply default-deny with no allowlist" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  # This script runs as ROOT via a lifecycle hook, whose PATH is not the interactive user's.
  echo "init-firewall: FATAL — 'node' not on root's PATH; cannot read the canonical allowlist" >&2
  exit 1
fi

GEN_ARGS=(--format ipset-domains)
if [ -n "${FORGE_REGISTRY_HOST:-}" ]; then
  GEN_ARGS+=(--forge-host "${FORGE_REGISTRY_HOST}")
  echo "init-firewall: forge registry host allowlisted from env"
else
  echo "init-firewall: FORGE_REGISTRY_HOST unset — forge registry NOT allowlisted (set it to pull from the forge)"
fi

# Capture into a variable rather than `mapfile < <(node …)`: with process substitution the
# generator's exit status is INVISIBLE to `set -e` (mapfile's own status is what is checked), so a
# crashed generator would yield an EMPTY array and this script would then apply default-DROP with
# nothing allowlisted — a total egress blackout that looks like a network fault, not a bug here.
if ! DOMAINS_RAW="$(node "${GEN}" "${GEN_ARGS[@]}")"; then
  echo "init-firewall: FATAL — gen-egress-policy.mjs failed; refusing to apply default-deny" >&2
  exit 1
fi

mapfile -t ALLOWED_DOMAINS <<< "${DOMAINS_RAW}"

# Belt and braces: an empty or whitespace-only list must never reach the DROP policy below.
if [ "${#ALLOWED_DOMAINS[@]}" -eq 0 ] || [ -z "${ALLOWED_DOMAINS[0]}" ]; then
  echo "init-firewall: FATAL — canonical allowlist resolved to zero domains; refusing to apply default-deny" >&2
  exit 1
fi
echo "init-firewall: read ${#ALLOWED_DOMAINS[@]} destinations from the canonical allowlist"

# NOTE: the forge registry host is appended by the generator above via --forge-host, so there is
# no second append here. Skip-cleanly-when-unset is preserved — it is now the generator's
# documented behaviour rather than a branch in this script (contracts/egress-allowlist.md).

# --- reset -------------------------------------------------------------------------------
# Reset INPUT/OUTPUT policy to ACCEPT FIRST: `iptables -F` clears rules but NOT the default
# policy, so a leftover DROP from a prior run would block this script's own DNS/HTTPS setup
# traffic on re-run (the runbook tells users to re-run to refresh stale registry IPs).
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
# Flush ONLY our own built-in chains. CRITICAL: do NOT run `iptables -X` and do NOT `-F FORWARD`
# — after `-F FORWARD` unreferences dockerd's user chains, `-X` DELETES them (DOCKER,
# DOCKER-FORWARD, DOCKER-ISOLATION-*, DOCKER-USER). dockerd then can't program iptables for a new
# network → `docker network create` / compose bring-up fails with
# `iptables: No chain/target/match by that name` (validated in the 037 pilot — T015a). The `nat`
# table and the FORWARD chain are owned by the in-container dockerd; leave them untouched.
iptables -F INPUT
iptables -F OUTPUT

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

# Feature 040: also allow egress over the dev container's OWN nested docker bridges. The app stacks
# come up on USER-DEFINED bridges (backend-network, keycloak-network, mcm-bff-network, …) created by
# `up-*` AFTER this script runs, on subnets the single HOST_CIDR above does NOT cover (it only catches
# the default-route bridge, ~docker0/172.17.x). Without this, `curl 127.0.0.1:PORT` from the
# dev-container shell is DNAT'd / docker-proxied to the container's real 172.1x IP, and that forward
# hop hits the default-DROP OUTPUT chain → the published app ports (BFF :8082, Keycloak :8099,
# mc-service :3001, …) are unreachable from the shell, blocking the browser web/agent E2E (integration
# tests were unaffected because container↔container is the FORWARD chain, left to dockerd).
# Reaching your OWN nested containers is LOCAL bridge traffic, not internet egress (RFC1918,
# non-internet-routable), so this does NOT weaken the anti-exfiltration posture — it only fixes the gap
# that the default-route allow missed. Scoped by docker bridge INTERFACE: `docker0` + the `br-*`
# user-defined bridges. The `br+` wildcard matches interfaces by name at packet time, so it covers
# bridges created LATER even though this rule is inserted at container start.
iptables -A OUTPUT -o docker0 -j ACCEPT
iptables -A OUTPUT -o 'br+'   -j ACCEPT
echo "init-firewall: allowed egress over local docker bridges (docker0 + br-*) — nested app stacks reachable"

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
