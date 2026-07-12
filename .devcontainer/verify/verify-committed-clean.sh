#!/usr/bin/env bash
# verify-committed-clean.sh — feature 038 (full dev-container toolchain)
#
# Governing success criterion: SC-010 (the committed .devcontainer/ carries the shared toolchain
# but ZERO personal tools/plugins/credentials, and no forge host literal). Governing requirements:
# FR-009 (personal layer out-of-repo), FR-010 (no credential baked/committed).
#
# Asserts that the committed CONFIG surface — devcontainer.json + the two Dockerfiles +
# init-firewall.sh — contains:
#   1. no `dotfiles.*` key (personal delivery is a per-user VS Code setting, never committed)
#   2. no personal-tool install (RTK / `cargo install --git` / `claude plugin install`)
#   3. no credential (delegates to scripts/secret-scan.mjs over the tree when available)
#   4. no forge host literal — MCM_DEVCONTAINER_IMAGE appears ONLY as `${localEnv:…}`
#      (delegates to scripts/check-topology-scrub.mjs when available)
#
# NOTE (deliberate scope): the *.devcontainer/verify/ scripts are EXCLUDED from the "no personal
# tooling" grep — verify-personal-layer.sh legitimately NAMES rtk/plugins because its job is to
# CHECK for them. SC-010 forbids CONFIGURING/INSTALLING personal tools in committed config, not
# mentioning them in a team-owned verification script.
#
# Runs on host or in-container (it inspects committed files, not runtime). Exit 0 = clean.

set -uo pipefail

# Resolve the repo's .devcontainer dir relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"          # .devcontainer/
REPO_ROOT="$(cd "${DC_DIR}/.." && pwd)"

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }
note(){ printf '  • %s\n' "$1"; }

echo "[verify-committed-clean] SC-010"

# The committed CONFIG files (NOT the verify scripts — see NOTE above).
CONFIG_FILES=(
  "${DC_DIR}/devcontainer.json"
  "${DC_DIR}/Dockerfile"
  "${DC_DIR}/toolchain.Dockerfile"
  "${DC_DIR}/init-firewall.sh"
)

# code_only <file> — emit the file with PURE-COMMENT lines removed, so the checks target active
# config (keys, RUN/command lines), not explanatory prose. SC-010 forbids CONFIGURING personal
# tooling, not documenting (in a comment) that the personal layer lives out-of-repo. JSONC comments
# are `//`; Dockerfile/sh comments are `#`. (Inline trailing comments are left in — the personal
# tooling words only ever appear in full-line comments here.)
code_only() {
  local f="$1"
  case "$f" in
    *.json)  grep -vE '^[[:space:]]*//' "$f" ;;
    *)       grep -vE '^[[:space:]]*#'  "$f" ;;   # Dockerfile, *.Dockerfile, *.sh
  esac
}

# grep_config <regex> <human label>  — fail if the pattern appears in any config file's CODE
# (comments stripped). Prints the offending non-comment lines.
grep_config() {
  local re="$1" label="$2" hit=0 f matches
  for f in "${CONFIG_FILES[@]}"; do
    [ -f "$f" ] || continue
    matches="$(code_only "$f" | grep -nEi "$re" || true)"
    if [ -n "$matches" ]; then
      err "$label — found (non-comment) in $(basename "$f"):"
      printf '%s\n' "$matches" | sed 's/^/      /' >&2
      hit=1
    fi
  done
  [ "$hit" -eq 0 ] && ok "no $label in committed config"
}

echo "  — no personal delivery / tooling in committed config"
grep_config 'dotfiles' 'dotfiles.* key (personal — belongs in per-user VS Code settings)'
grep_config '\brtk\b' 'RTK reference (personal layer — dotfiles-only)'
grep_config 'cargo[[:space:]]+install[[:space:]]+--git' 'cargo install --git (personal RTK build — dotfiles-only)'
grep_config 'claude[[:space:]]+plugin[[:space:]]+install' 'claude plugin install (personal — dotfiles-only)'

echo "  — MCM_DEVCONTAINER_IMAGE only as \${localEnv:…} (no forge host literal)"
# Any bare occurrence of MCM_DEVCONTAINER_IMAGE that is NOT inside a ${localEnv:…} is suspect.
img_bad=0
for f in "${CONFIG_FILES[@]}"; do
  [ -f "$f" ] || continue
  # Active (non-comment) lines mentioning the var but NOT via ${localEnv:MCM_DEVCONTAINER_IMAGE...}
  while IFS= read -r line; do
    case "$line" in
      *'${localEnv:MCM_DEVCONTAINER_IMAGE'*) : ;;                  # OK — substitution form
      *MCM_DEVCONTAINER_IMAGE*) err "MCM_DEVCONTAINER_IMAGE not via \${localEnv} in $(basename "$f"): ${line}"; img_bad=1 ;;
    esac
  done < <(code_only "$f" | grep -n 'MCM_DEVCONTAINER_IMAGE' 2>/dev/null || true)
done
[ "$img_bad" -eq 0 ] && ok "MCM_DEVCONTAINER_IMAGE referenced only as \${localEnv:…}"

# --- delegate to the repo's real gates when available (whole-tree) -----------------------
run_gate() {
  local script="$1" label="$2"
  if command -v node >/dev/null 2>&1 && [ -f "${REPO_ROOT}/scripts/${script}" ]; then
    if ( cd "${REPO_ROOT}" && node "scripts/${script}" >/dev/null 2>&1 ); then
      ok "${label} passed (scripts/${script})"
    else
      err "${label} FAILED (scripts/${script}) — run it directly for details"
    fi
  else
    note "${label} skipped (node or scripts/${script} unavailable here) — CI runs it authoritatively"
  fi
}
echo "  — repo credential + topology gates (authoritative in CI)"
run_gate 'secret-scan.mjs' 'secret-scan (no credential in the tree, FR-010)'
run_gate 'check-topology-scrub.mjs' 'topology-scrub (forge host not a git literal)'

if [ "$fail" -eq 0 ]; then
  echo "[verify-committed-clean] PASS (SC-010 — committed config is personal-free & secret-free)"; exit 0
else
  echo "[verify-committed-clean] FAIL (SC-010)"; exit 1
fi
