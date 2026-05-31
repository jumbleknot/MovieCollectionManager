#requires -Version 5.1
<#
.SYNOPSIS
  Builds the Android debug APK on Windows by working around the CMAKE_OBJECT_PATH_MAX
  (250) wall that RN 0.85 C++ modules (react-native-worklets, react-native-screens) hit
  under this repo's deep path + pnpm layout (feature 006, FR-010).

.DESCRIPTION
  The 250-char cap is internal to CMake (Windows LongPathsEnabled does NOT help). The
  repo's absolute source path appears ~twice in each object path, overflowing the cap
  (worst measured 381 chars). The only reliable local fix is a SHORT build root + a flat
  node_modules:
    1. junction a short root (C:\m) to the repo               (object path 381 -> ~187)
    2. add `node-linker=hoisted` to .npmrc + reinstall        (drops the .pnpm/<hash> nesting)
    3. build via the Nx target `mcm-app:build-apk` from the short root
    4. ALWAYS revert: remove hoisted, reinstall (symmetrical layout Metro/jest need), drop junction

  On a Linux CI runner this whole dance is unnecessary — see .github/workflows/android-apk.yml.

.PARAMETER JunctionPath  Short build root (default C:\m). Created if absent, removed if we created it.
.PARAMETER Abi           reactNativeArchitectures to build (default x86_64 for the emulator; '' = all ABIs).
.PARAMETER Install       Also `adb install -r` the resulting APK after a successful build.
#>
[CmdletBinding()]
param(
  [string]$JunctionPath = 'C:\m',
  [string]$Abi = 'x86_64',
  [switch]$Install
)
$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$npmrc = Join-Path $repo '.npmrc'
$hoistedLine = 'node-linker=hoisted'

$weAddedHoisted = $false
$weMadeJunction = $false

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

try {
  # 1. Short build root (junction — no copy, no admin).
  if (-not (Test-Path $JunctionPath)) {
    Write-Step "Creating junction $JunctionPath -> $repo"
    cmd /c "mklink /J `"$JunctionPath`" `"$repo`"" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "mklink failed (exit $LASTEXITCODE)" }
    $weMadeJunction = $true
  } else {
    Write-Step "Reusing existing $JunctionPath"
  }

  # 2. Flat node_modules (build-only).
  $npmrcText = Get-Content $npmrc -Raw -ErrorAction SilentlyContinue
  if ($npmrcText -notmatch '(?m)^\s*node-linker\s*=\s*hoisted\s*$') {
    Write-Step "Adding '$hoistedLine' to .npmrc (build-only)"
    Add-Content -Path $npmrc -Value "`n$hoistedLine"
    $weAddedHoisted = $true
  }
  Write-Step "Installing with flat node_modules from the short root"
  Push-Location $JunctionPath
  try { pnpm install; if ($LASTEXITCODE -ne 0) { throw "pnpm install (hoisted) failed" } }
  finally { Pop-Location }

  # 3. Build the APK via the Nx target, from the short root.
  Write-Step "Building APK via Nx target (APK_ABI='$Abi')"
  Push-Location (Join-Path $JunctionPath 'frontend\mcm-app')
  try {
    $env:APK_ABI = $Abi
    & "$JunctionPath\node_modules\.bin\nx.cmd" run mcm-app:build-apk
    if ($LASTEXITCODE -ne 0) { throw "nx run mcm-app:build-apk failed (exit $LASTEXITCODE)" }
  } finally {
    Remove-Item Env:\APK_ABI -ErrorAction SilentlyContinue
    Pop-Location
  }

  $apk = Join-Path $repo 'frontend\mcm-app\android\app\build\outputs\apk\debug\app-debug.apk'
  Write-Step "APK at: $apk"

  if ($Install) {
    Write-Step "adb install -r"
    adb install -r "$apk" | Out-Host
  }
}
finally {
  # 4. ALWAYS revert — hoisted breaks Metro/jest module resolution; never leave it active.
  if ($weAddedHoisted) {
    Write-Step "Reverting: removing '$hoistedLine' from .npmrc"
    $lines = Get-Content $npmrc | Where-Object { $_ -notmatch '(?m)^\s*node-linker\s*=\s*hoisted\s*$' }
    Set-Content -Path $npmrc -Value $lines -Encoding utf8
    Write-Step "Reinstalling from the real repo path (restores symmetrical layout)"
    Push-Location $repo
    try { pnpm install } finally { Pop-Location }
  }
  if ($weMadeJunction -and (Test-Path $JunctionPath)) {
    Write-Step "Removing junction $JunctionPath"
    cmd /c "rmdir `"$JunctionPath`"" | Out-Host
  }
}
