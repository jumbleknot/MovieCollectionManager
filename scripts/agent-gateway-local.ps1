<#
.SYNOPSIS
  Run the feature-012 Agent Gateway as a container on backend-network for local
  CONTAINER-BFF E2E (dev-container / prod-container), reusing the HOST Ollama models.

.DESCRIPTION
  The committed `--profile agents` compose stack runs a fully-containerized gateway with
  its own Ollama container (a ~19 GB model pull) + movie-assistant-store-postgres (Postgres checkpointer, only
  needed once the graph uses a persistent checkpointer — T024). For the local Metro-free
  E2E regression we don't want either: the current graph uses an in-memory checkpointer,
  and the host already has the qwen2.5 models pulled. This helper runs ONLY the gateway,
  on backend-network, pointing OLLAMA_BASE_URL at the host via host.docker.internal — so
  the container BFF (mcm-bff-service-nonsecure / mcm-bff-service-secure) reaches it at http://movie-assistant-gateway:8000 by
  service DNS (the .env.docker AGENT_GATEWAY_URL value). This is the path that unblocks
  Finding A; see specs/012-multi-agent-mvp/HANDOFF.md.

  Constitution boundary preserved: NO host port is published (the gateway is reachable
  only from backend-network — the BFF is the sole caller).

.PARAMETER Down
  Remove the gateway container.

.PARAMETER Build
  (Re)build agent-gateway:latest before starting.

.EXAMPLE
  pwsh scripts/agent-gateway-local.ps1 -Build
  # then: pnpm nx up-mcm infrastructure-as-code   # (--profile bff-nonsecure → mcm-bff-service-nonsecure)
  #       E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
#>
[CmdletBinding()]
param(
  [switch]$Down,
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ($Down) {
  docker rm -f movie-assistant-gateway 2>$null | Out-Null
  Write-Host 'movie-assistant-gateway removed.'
  return
}

# Prerequisite: backend-network exists (created by first-time setup / keycloak compose).
$net = docker network ls --format '{{.Name}}' | Where-Object { $_ -eq 'backend-network' }
if (-not $net) { throw "backend-network not found. Run: docker network create backend-network" }

# Prerequisite: host Ollama serving with the models pulled.
try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  Write-Host "Host Ollama up: $($tags.models.Count) model(s)."
} catch {
  throw "Host Ollama not reachable on :11434. Start it and pull qwen2.5 / qwen2.5:32b."
}

if ($Build -or -not (docker images -q agent-gateway:latest)) {
  Write-Host 'Building agent-gateway:latest ...'
  docker build -t agent-gateway:latest -f agents/movie-assistant/Dockerfile .
  if ($LASTEXITCODE -ne 0) { throw 'gateway image build failed' }
}

docker rm -f movie-assistant-gateway 2>$null | Out-Null
docker run -d --name movie-assistant-gateway --network backend-network `
  --add-host host.docker.internal:host-gateway `
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 `
  -e MODEL_PROVIDER=ollama `
  -e KEYCLOAK_URL=http://keycloak-service:8080 `
  -e KEYCLOAK_REALM=grumpyrobot `
  agent-gateway:latest | Out-Null

Start-Sleep -Seconds 5
$health = docker run --rm --network backend-network curlimages/curl:latest -s -m 10 http://movie-assistant-gateway:8000/health
if ($health -notmatch 'ok') { throw "gateway /health did not return ok (got: $health)" }
Write-Host "movie-assistant-gateway up on backend-network — /health => $health"
Write-Host "BFF reaches it at http://movie-assistant-gateway:8000 (set in frontend/mcm-app/.env.docker AGENT_GATEWAY_URL)."
