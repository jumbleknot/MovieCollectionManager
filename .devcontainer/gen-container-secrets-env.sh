#!/usr/bin/env bash
# gen-container-secrets-env.sh — write the dev container's credential env file.
#
# ── Why this file exists ─────────────────────────────────────────────────────────────────────────
#
# These four credentials used to be listed in devcontainer.json's `containerEnv`. The devcontainer
# CLI turns every `containerEnv` entry into an **ENV instruction in the generated
# Dockerfile-with-features**, so they were BAKED INTO THE IMAGE. Measured 2026-09-19 on the derived
# image: all four present in `Config.Env`, and literal values in **3 history layers**. That is a
# permanent leak — it survives every container recreate, and `docker image inspect` or
# `docker history` hands the values to anyone who can read the image. The same `containerEnv` also
# made `devcontainer up` print them in clear text on the `docker run` command line on every rebuild.
#
# The textbook fix — move them to `remoteEnv` — is NOT available here, and devcontainer.json says
# why: this sandbox is routinely entered by `ssh mcm.sbx` + `docker exec`, and `remoteEnv` does not
# apply to those. Switching would silently strip the credentials from the path used most.
#
# So they are passed with `docker run --env-file` instead (wired through `runArgs`). Measured:
#   • `docker exec` DOES inherit them          → the requirement that ruled out remoteEnv is met
#   • they are NOT in the image                → the permanent, shareable leak is gone
#   • only the FILE PATH appears on the command line, never the values
#   • they remain visible via `docker inspect <container>` — inherent, and the accepted residue:
#     if `docker exec` must see a variable, the container's own config has to carry it.
#
# ── Why a generator, rather than pointing --env-file at ~/.mcm-sandbox-env ────────────────────────
#
# `docker --env-file` is NOT a shell: it does no quote processing and takes the bytes literally.
# Measured 2026-09-19 — given `Q1='quoted'`, the container sees `Q1=['quoted']`, quotes included.
# ~/.mcm-sandbox-env uses the shell's `KEY='value'` form, so feeding it to docker directly would
# inject credentials wrapped in stray apostrophes, which fail authentication in a way that reads as
# a bad key rather than a quoting bug. This script sources it as a shell (correct parsing) and
# re-emits the bare `KEY=value` form docker actually wants.
set -uo pipefail

SRC="${MCM_SANDBOX_ENV_FILE:-$HOME/.mcm-sandbox-env}"
OUT="${MCM_CONTAINER_SECRETS_ENV:-$HOME/.mcm-devcontainer-secrets.env}"

# Exactly the credentials that were in containerEnv. FORGE_REGISTRY_HOST is deliberately NOT here:
# it is a hostname, not a secret, and stays in containerEnv where it is harmless.
VARS="MCM_ANTHROPIC_API_KEY TMDB_API_KEY MCM_FORGE_TOKEN MCM_FORGE_ISSUE_TOKEN"

# Create it private BEFORE writing, never after: a chmod that follows the write leaves a window in
# which the credentials are world-readable on a multi-user box.
umask 077
: > "$OUT" || { echo "[gen-container-secrets-env] ✗ cannot write $OUT" >&2; exit 1; }
chmod 600 "$OUT" 2>/dev/null || true

if [ -f "$SRC" ]; then
  # shellcheck disable=SC1090
  set -a; . "$SRC"; set +a
else
  # An empty file still lets `docker run --env-file` succeed. Failing the container start here would
  # turn "no credentials provisioned yet" into "the dev container will not boot", which is a much
  # worse first-run experience — and the absence is reported loudly below either way.
  echo "[gen-container-secrets-env] ⚠ $SRC not found — writing an EMPTY env file."
  echo "[gen-container-secrets-env]   The container will start WITHOUT credentials; see"
  echo "[gen-container-secrets-env]   docs/runbooks/devcontainer-sandbox.md §8b (the D-07 fallback)."
fi

written=0
missing=""
for v in $VARS; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then missing="$missing $v"; continue; fi
  # docker's env-file format is one KEY=VALUE per line and has no continuation syntax, so a value
  # containing a newline would silently become a bogus extra entry. Refuse rather than corrupt.
  case "$val" in
    *"$(printf '\n')"*)
      echo "[gen-container-secrets-env] ✗ $v contains a newline — refusing to emit it" >&2
      continue ;;
  esac
  printf '%s=%s\n' "$v" "$val" >> "$OUT"
  written=$((written + 1))
done

# Report names and LENGTHS only. A generator for credentials must never be the thing that prints
# them — that is the defect this whole file exists to remove.
echo "[gen-container-secrets-env] wrote $written/4 credential(s) to $OUT (mode $(stat -c '%a' "$OUT" 2>/dev/null || echo '?'))"
for v in $VARS; do
  eval "val=\${$v:-}"
  if [ -n "$val" ]; then echo "  ✓ $v (${#val} chars)"; fi
done
[ -n "$missing" ] && echo "  ⚠ not provisioned:$missing"

exit 0
