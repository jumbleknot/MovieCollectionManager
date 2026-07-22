#!/usr/bin/env bash
# Dev-container Ollama bootstrap (feat devcontainer-ollama).
#
# WHY: heavy agent-flow churn on the Anthropic API is expensive. Ollama used to serve the dev models
# for free from the Windows host, reached via host.docker.internal — but once the dev container became
# nested-DinD, host.docker.internal resolves to THIS container, not Windows, so that path broke and
# MODEL_PROVIDER=anthropic became the only option. The fix: serve Ollama HERE, as a nested container
# publishing :11434 on the dev container. The agent gateway (also nested) already targets
# `host.docker.internal:11434` (compose default + its extra_hosts host-gateway mapping), which
# resolves to this dev container — so it reaches this container with ZERO gateway/compose change.
#
# Proven live 2026-07-21: nested→host.docker.internal:11434 works through the firewall, and this
# container pulls models over dockerd's FORWARD chain (unfirewalled) — no rebuild, no firewall change.
#
# Runs from postStartCommand. Idempotent and best-effort — must never block or fail container start.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${REPO_ROOT}/infrastructure-as-code/docker/dev-ollama.compose.yaml"
MODEL="${DEVCONTAINER_OLLAMA_MODEL:-qwen2.5}"

if ! docker info >/dev/null 2>&1; then
  echo "devcontainer-ollama: nested docker not ready — skipping (agent flows will fall back to Anthropic)."
  exit 0
fi

# Bring the server up (idempotent — no-op if already running).
docker compose -f "$COMPOSE" up -d >/dev/null 2>&1 \
  || { echo "devcontainer-ollama: 'compose up' failed — see 'docker compose -f $COMPOSE logs'."; exit 0; }

# Wait briefly for the API.
for _ in $(seq 1 20); do
  curl -sf -m 2 "http://localhost:11434/api/version" >/dev/null 2>&1 && break
  sleep 0.5
done

if ! curl -sf -m 2 "http://localhost:11434/api/version" >/dev/null 2>&1; then
  echo "devcontainer-ollama: server not up yet — 'docker logs dev-ollama' to check."
  exit 0
fi

# Pull the dev fast-model once (persisted in the dev-ollama-models volume). Backgrounded so a first-run
# ~4.7 GB pull never blocks container readiness. qwen2.5:32b (the balanced tier) is large + slow on
# CPU — pull it by hand only if needed:  docker exec dev-ollama ollama pull qwen2.5:32b
if ! docker exec dev-ollama ollama list 2>/dev/null | awk '{print $1}' | grep -qE "^${MODEL}(:latest)?$"; then
  echo "devcontainer-ollama: pulling ${MODEL} in the background (one-time; dev-ollama-models volume)."
  setsid docker exec dev-ollama ollama pull "${MODEL}" >/tmp/ollama-pull.log 2>&1 &
fi

echo "devcontainer-ollama: ready on host.docker.internal:11434 — agent flows can run on Ollama (MODEL_PROVIDER=ollama)."
exit 0
