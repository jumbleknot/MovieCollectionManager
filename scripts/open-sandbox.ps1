<#
.SYNOPSIS
  Open the MCM dev container on the Docker Sandbox microVM in ONE step.

.DESCRIPTION
  Replaces the four-step manual dance:

      1. open VS Code
      2. Remote-SSH: Connect to Host        -> mcm.sbx
      3. File > Open Folder                 -> /workspaces/mcm
      4. Dev Containers: Attach to Running Container

  VS Code can address a dev container that lives inside a remote SSH host directly, with a single
  compound URI:

      vscode-remote://dev-container+<hex>@ssh-remote+<host>/<workspace>

  where <hex> is the hex-encoded UTF-8 of a small JSON descriptor. This script builds that URI and
  hands it to `code --folder-uri`, which lands straight in the container.

  THE HEX IS GENERATED, NOT PASTED. It would have been quicker to hardcode the string VS Code
  produced, but a hardcoded URI silently opens the WRONG target the moment the workspace path or the
  config file moves — and "wrong target" here means a window that looks correct while running
  somewhere else. Generating it from the same inputs keeps it honest, and the round-trip was
  verified byte-identical (332 hex chars) against the URI VS Code itself recorded in storage.json.

  ALSO HANDLES THE IDLE-STOP. The microVM stops ~30 s after the last session disconnects, so the
  common case is that the sandbox is *not* running when you come back to it. Attaching to a stopped
  sandbox fails in a way that reads like a broken environment, so this checks and starts it first.
  Note `sbx start` DOES NOT EXIST — `sbx run --name <n>` is the documented restart path, and passing
  the name is what re-attaches rather than creating a second sandbox.

.PARAMETER Sandbox
  Sandbox name. Default: mcm

.PARAMETER Workspace
  Workspace folder INSIDE the VM. Default: /workspaces/mcm

.PARAMETER Config
  devcontainer.json path inside the VM. Default: the sandbox variant.

.PARAMETER SshHost
  SSH host alias for the sandbox, as configured in ~/.ssh/config. Default: <sandbox>.sbx

.PARAMETER PrintOnly
  Print the URI and exit without launching VS Code (useful for building a shortcut).

.EXAMPLE
  pwsh scripts/open-sandbox.ps1
.EXAMPLE
  pwsh scripts/open-sandbox.ps1 -PrintOnly
#>
[CmdletBinding()]
param(
  [string]$Sandbox   = 'mcm',
  [string]$Workspace = '/workspaces/mcm',
  [string]$Config    = '/workspaces/mcm/.devcontainer/sandbox/devcontainer.json',
  [string]$SshHost   = '',
  [switch]$PrintOnly
)

$ErrorActionPreference = 'Stop'
if (-not $SshHost) { $SshHost = "$Sandbox.sbx" }

function Test-Cmd([string]$Name) {
  $c = Get-Command $Name -ErrorAction SilentlyContinue
  return [bool]$c
}

if (-not (Test-Cmd 'sbx')) {
  Write-Error "sbx not on PATH. Add %LOCALAPPDATA%\DockerSandboxes\bin to PATH."
}

# ── 1. make sure the sandbox is actually running ────────────────────────────────────────────────
# `sbx ls` is the only status source; parse the row for this sandbox rather than trusting exit code.
$row = (& sbx ls 2>$null | Select-String -Pattern "^\s*$([regex]::Escape($Sandbox))\s")
if (-not $row) {
  Write-Error "sandbox '$Sandbox' does not exist. Create it first (see docs/runbooks/devcontainer-sandbox.md)."
}

if ($row -match '\brunning\b') {
  Write-Host "  sandbox '$Sandbox' is already running"
} else {
  Write-Host "  sandbox '$Sandbox' is stopped (the microVM idle-stops ~30s after the last session) - starting..."
  # -d prints the id and exits rather than opening an interactive session; --name re-attaches to the
  # EXISTING sandbox (without it, the positional agent argument would create a new one).
  & sbx run --name $Sandbox -d | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error "sbx run failed for '$Sandbox'." }

  # Wait for SSH rather than assuming: VS Code's attach fails confusingly if it races the boot.
  #
  # ⚠️ Windows PowerShell 5.1: do NOT redirect a native exe's stderr (`2>$null`) here. 5.1 wraps each
  # stderr line in an ErrorRecord (NativeCommandError), and with $ErrorActionPreference='Stop' that
  # becomes a TERMINATING error even when the exe exits 0. `ssh` writes "Connecting to sandbox …" to
  # stderr on every call, so the redirect turned a perfectly successful probe into a script abort.
  # Measured 2026-08-16. Exit code is the only trustworthy signal; let stderr through and suppress
  # error escalation for the duration of the loop instead.
  $ready = $false
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    foreach ($i in 1..30) {
      & ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=3 $SshHost 'true' | Out-Null
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      Start-Sleep -Seconds 2
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if (-not $ready) {
    Write-Error "sandbox started but $SshHost did not answer SSH within ~60s. Check: sbx ls / ssh $SshHost"
  }
  Write-Host "  sandbox is up and answering SSH"
}

# ── 2. build the compound URI ───────────────────────────────────────────────────────────────────
# Key order and the "$mid":1 member are reproduced exactly as VS Code emits them. JSON is
# order-insensitive to a parser, but matching the observed form keeps this diffable against a real
# URI when something changes in a future VS Code release.
$descriptor = '{"hostPath":"' + $Workspace + '","localDocker":false,"configFile":{"$mid":1,"path":"' +
              $Config + '","scheme":"vscode-fileHost"}}'

$bytes = [System.Text.Encoding]::UTF8.GetBytes($descriptor)
$hex   = -join ($bytes | ForEach-Object { $_.ToString('x2') })

# '+' must be percent-encoded as %2B in both authority segments, or VS Code reads the URI as a
# malformed authority and silently opens a local window instead.
$uri = "vscode-remote://dev-container%2B$hex@ssh-remote%2B$SshHost$Workspace"

if ($PrintOnly) { Write-Output $uri; exit 0 }

if (-not (Test-Cmd 'code')) {
  Write-Host "  'code' is not on PATH - open this URI manually:`n"
  Write-Output $uri
  exit 0
}

Write-Host "  opening VS Code in the dev container..."
& code --folder-uri $uri
Write-Host "  done. VS Code should land directly inside the container (no Attach step needed)."
