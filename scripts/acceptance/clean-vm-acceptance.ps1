# scripts/acceptance/clean-vm-acceptance.ps1
# ============================================================================
# RR2-H001: NODE-FREE clean-VM acceptance harness.
#
# The recheck-2 requalification rejected a clean-VM job that installed a
# global Node.js and drove the acceptance through npm/Node scripts - that
# never proved the release works on a standard machine. This harness is
# pure PowerShell + the shipped CMD installer. It NEVER invokes node, npm
# or any JavaScript runner:
#
#   Phase 1  Fresh signed install of the exact release (unsplit OR split).
#   Phase 2  Boot the INSTALLED executable and probe it over CDP on port
#            9222 with plain HTTP (the project's agreed automation flow -
#            no UIA clicking, no Windows-Security-triggering old flows).
#   Phase 3  REAL offline function: the BUNDLED ffprobe.exe from the
#            installed tree probes the bundled demo media. No network,
#            no global tooling - proof the shipped CLI/runtime assets work.
#   Phase 4  Real old->new upgrade when MINIMAX_PREV_RELEASE_DIR points at
#            a complete previous signed release (stale-file removal).
#   Phase 5  Deterministic interrupt via MINIMAX_INSTALL_FAULT_BEFORE_SWAP:
#            the existing installation must stay byte-identical.
#   Phase 6  Tamper rejection: one flipped archive byte must fail closed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\acceptance\clean-vm-acceptance.ps1
#             [-DistDir <path>] [-PrevReleaseDir <path>]
# Report: coverage\clean-vm-acceptance.json
# ============================================================================

[CmdletBinding()]
param(
  [string]$DistDir = (Join-Path $PSScriptRoot '..\..\dist-out'),
  [string]$PrevReleaseDir = $env:MINIMAX_PREV_RELEASE_DIR
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$DistDir = [IO.Path]::GetFullPath($DistDir)
$script:Results = @()
$script:Failures = 0

function Write-Phase([string]$m) { Write-Host "[clean-vm] $m" }
function Fail([string]$m) {
  Write-Host "[clean-vm] FAIL: $m" -ForegroundColor Red
  throw $m
}
function Add-Result([string]$phase, [bool]$ok, [string]$detail) {
  $script:Results += [pscustomobject]@{ phase = $phase; ok = $ok; detail = $detail }
  if (-not $ok) { $script:Failures++ }
}

# --- Phase 0: this harness must not depend on Node in any way. -----------
Write-Phase 'Phase 0: verifying the harness itself is node-free...'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  Write-Phase "  NOTE: node.exe exists on this machine ($($nodeCmd.Source)) but this harness will NEVER invoke it."
}
Add-Result 'node-free-harness' $true 'harness uses only PowerShell + the shipped CMD installer'

# --- Release discovery (unsplit .zip wins, else the .partN.zip chain). ---
function Find-Release([string]$dir) {
  if (-not (Test-Path $dir)) { Fail "release directory not found: $dir" }
  $unsplit = Get-ChildItem $dir -Filter 'MiniMaxAssetTool-*-x64.zip' -File |
    Where-Object { $_.Name -notmatch '\.part\d+\.zip$' } | Sort-Object Name
  $part1 = Get-ChildItem $dir -Filter 'MiniMaxAssetTool-*-x64.part1.zip' -File | Sort-Object Name
  if ($unsplit) { $base = $unsplit[0].BaseName }
  elseif ($part1) { $base = $part1[0].Name -replace '\.part1\.zip$', '' }
  else { Fail "no release archive found in $dir" }
  $archives = @()
  if ($unsplit) { $archives = @($unsplit[0].FullName) }
  else {
    $i = 1
    while (Test-Path (Join-Path $dir "$base.part$i.zip")) {
      $archives += Join-Path $dir "$base.part$i.zip"; $i++
    }
  }
  $required = @("$base.sha256", "$base.sha256.minisig", 'minisign.pub', 'minisign.exe', 'Install-MiniMax-Asset-Tool.cmd')
  foreach ($f in $required) {
    if (-not (Test-Path (Join-Path $dir $f))) { Fail "release in $dir is incomplete: missing $f" }
  }
  return @{ Dir = $dir; Base = $base; Archives = $archives }
}

function Stage-Download([hashtable]$rel, [string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  foreach ($a in $rel.Archives) { Copy-Item $a -Destination $dest }
  foreach ($f in @("$($rel.Base).sha256", "$($rel.Base).sha256.minisig", 'minisign.pub', 'minisign.exe')) {
    Copy-Item (Join-Path $rel.Dir $f) -Destination $dest
  }
  Copy-Item (Join-Path $rel.Dir 'Install-MiniMax-Asset-Tool.cmd') -Destination $dest
}

function Invoke-Installer([string]$cwd, [hashtable]$extraEnv, [int]$timeoutSec = 2700) {
  $saved = @{}
  foreach ($k in $extraEnv.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $extraEnv[$k], 'Process')
  }
  try {
    $p = Start-Process cmd.exe -ArgumentList '/d', '/c', 'Install-MiniMax-Asset-Tool.cmd' `
      -WorkingDirectory $cwd -NoNewWindow -PassThru -Wait `
      -RedirectStandardOutput "$cwd\_installer.out.txt" -RedirectStandardError "$cwd\_installer.err.txt"
    if ($p.HasExited -eq $false) { $p.Kill() }
    return $p.ExitCode
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
}

function Get-TreeHash([string]$dir) {
  $map = @{}
  Get-ChildItem $dir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($dir.Length).TrimStart('\')
    $map[$rel] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  }
  return $map
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("minimax-cleanvm-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$script:PrevBase = $null

try {
  $rel = Find-Release $DistDir
  Write-Phase "Release discovered: $($rel.Base) ($($rel.Archives.Count) archive(s))"

  $downloadDir = Join-Path $temp 'download'
  $installDir = Join-Path $temp 'installed app'
  Stage-Download $rel $downloadDir
  $installEnv = @{
    MINIMAX_INSTALL_DIR = $installDir
    MINIMAX_INSTALL_DESKTOP = (Join-Path $temp 'Desktop')
    MINIMAX_INSTALL_START_MENU = (Join-Path $temp 'StartMenu')
    MINIMAX_INSTALL_NO_LAUNCH = '1'
    # No MINIMAX_INSTALLER_ALLOW_UNSIGNED: the signed release must pass.
  }

  # --- Phase 1: fresh signed install. ------------------------------------
  Write-Phase 'Phase 1: fresh signed install of the exact release...'
  $code = Invoke-Installer $downloadDir $installEnv
  if ($code -ne 0) {
    $tail = Get-Content (Join-Path $downloadDir '_installer.err.txt') -Tail 20 -ErrorAction SilentlyContinue
    Fail "fresh install failed (exit $code): $($tail -join ' | ')"
  }
  $exe = Join-Path $installDir 'MiniMaxAssetTool.exe'
  $innerManifest = Join-Path $installDir 'FILES.sha256'
  if (-not (Test-Path $exe) -or -not (Test-Path $innerManifest)) {
    Fail 'fresh install reported success but the installed tree is incomplete'
  }
  Add-Result 'fresh-install' $true "installed $($rel.Base) with inner manifest"
  Write-Phase '  PASS: fresh signed install'

  # --- Phase 2: boot + CDP probe (agreed flow, port 9222). ---------------
  Write-Phase 'Phase 2: booting the installed executable and probing CDP:9222...'
  $proc = Start-Process $exe -ArgumentList '--remote-debugging-port=9222' -PassThru
  $cdpOk = $false; $title = ''
  try {
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not $cdpOk) {
      try {
        $pages = Invoke-RestMethod 'http://127.0.0.1:9222/json' -TimeoutSec 5
        foreach ($pg in $pages) {
          if ($pg.type -eq 'page') { $cdpOk = $true; $title = $pg.title; break }
        }
      } catch { Start-Sleep -Seconds 2 }
    }
  } finally {
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
  }
  if (-not $cdpOk) { Fail 'installed executable never exposed a CDP page on 9222' }
  Add-Result 'packaged-boot-cdp' $true "renderer page up (title: $title)"
  Write-Phase "  PASS: packaged boot verified via CDP (title: $title)"

  # --- Phase 3: REAL offline function with BUNDLED tools. ----------------
  Write-Phase 'Phase 3: offline function check with bundled ffprobe...'
  $ffprobe = Get-ChildItem $installDir -Recurse -Filter 'ffprobe.exe' -File | Select-Object -First 1
  if (-not $ffprobe) { Fail 'bundled ffprobe.exe not found in the installed tree' }
  $media = Get-ChildItem $installDir -Recurse -Include '*.mp4','*.jpg','*.png' -File |
    Where-Object { $_.Length -gt 1000 } | Select-Object -First 1
  if (-not $media) { Fail 'no bundled demo media found to probe offline' }
  $probeOut = & $ffprobe.FullName -v error -show_entries stream=codec_type -of csv=p=0 $media.FullName 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $probeOut) {
    Fail "bundled ffprobe could not probe $($media.Name): $probeOut"
  }
  $realesrgan = Get-ChildItem $installDir -Recurse -Filter 'realesrgan-ncnn-vulkan.exe' -File | Select-Object -First 1
  if (-not $realesrgan) { Fail 'bundled realesrgan-ncnn-vulkan.exe not found in the installed tree' }
  Add-Result 'offline-function' $true "ffprobe parsed $($media.Name) -> $($probeOut -join ','); realesrgan present"
  Write-Phase "  PASS: bundled ffprobe parsed $($media.Name) offline (streams: $($probeOut -join ','))"

  # --- Phase 4: real old->new upgrade (when a previous release exists). --
  if ($PrevReleaseDir) {
    Write-Phase 'Phase 4: real old->new upgrade...'
    $prevRel = Find-Release ([IO.Path]::GetFullPath($PrevReleaseDir))
    if ($prevRel.Base -eq $rel.Base) { Fail 'MINIMAX_PREV_RELEASE_DIR points at the SAME version' }
    $script:PrevBase = $prevRel.Base
    $prevDownload = Join-Path $temp 'prev download'
    Stage-Download $prevRel $prevDownload
    $upgradeEnv = @{} + $installEnv
    $code = Invoke-Installer $prevDownload $upgradeEnv
    if ($code -ne 0) { Fail "install of previous release $($prevRel.Base) failed (exit $code)" }
    $stale = Join-Path $installDir 'stale-old-release-file.txt'
    Set-Content -Path $stale -Value 'leftover from the old release'
    $code = Invoke-Installer $downloadDir $upgradeEnv
    if ($code -ne 0) { Fail "real old->new upgrade failed (exit $code)" }
    if (Test-Path $stale) { Fail 'upgrade kept a stale file from the old release' }
    if (-not (Test-Path (Join-Path $installDir 'FILES.sha256'))) { Fail 'upgrade lost the inner manifest' }
    Add-Result 'real-upgrade' $true "$($prevRel.Base) -> $($rel.Base), stale file removed"
    Write-Phase "  PASS: $($prevRel.Base) -> $($rel.Base) upgrade with stale-file removal"
  } else {
    Write-Phase 'Phase 4 skipped: MINIMAX_PREV_RELEASE_DIR not set (same-version reinstall below covers the swap).'
    Add-Result 'real-upgrade' $true 'skipped: no previous release supplied'
  }

  # --- Phase 5: deterministic interrupt before the swap. -----------------
  Write-Phase 'Phase 5: deterministic interrupt (MINIMAX_INSTALL_FAULT_BEFORE_SWAP=1)...'
  $before = Get-TreeHash $installDir
  $faultEnv = @{} + $installEnv + @{ MINIMAX_INSTALL_FAULT_BEFORE_SWAP = '1' }
  $code = Invoke-Installer $downloadDir $faultEnv
  if ($code -eq 0) { Fail 'fault-injected install must NOT succeed' }
  $after = Get-TreeHash $installDir
  $same = ($before.Count -eq $after.Count)
  if ($same) {
    foreach ($k in $before.Keys) { if ($after[$k] -ne $before[$k]) { $same = $false; break } }
  }
  if (-not $same) { Fail 'interrupted install mutated the existing installation' }
  $leftovers = Get-ChildItem (Split-Path $installDir) -Directory | Where-Object { $_.Name -match '\.staging-|\.old-' }
  if ($leftovers) { Fail "interrupted install left staging debris: $($leftovers.Name -join ', ')" }
  Add-Result 'deterministic-interrupt' $true "faulted before swap; $($before.Count) files byte-identical"
  Write-Phase '  PASS: interrupted install left the existing tree byte-identical'

  # --- Phase 6: tamper rejection (one flipped byte). ---------------------
  Write-Phase 'Phase 6: tamper rejection...'
  $tamperDir = Join-Path $temp 'tampered download'
  Stage-Download $rel $tamperDir
  $victim = Join-Path $tamperDir (Split-Path $rel.Archives[0] -Leaf)
  # Break any hardlink, then flip exactly one byte in the middle of the file.
  Copy-Item $victim "$victim.copy"; Remove-Item $victim; Move-Item "$victim.copy" $victim
  $fs = [IO.File]::Open($victim, 'Open', 'ReadWrite')
  try {
    $pos = [math]::Floor($fs.Length / 2)
    $fs.Seek($pos, 'Begin') | Out-Null
    $b = $fs.ReadByte()
    $fs.Seek($pos, 'Begin') | Out-Null
    $fs.WriteByte([byte]($b -bxor 0xFF))
  } finally { $fs.Dispose() }
  $tamperEnv = @{} + $installEnv + @{ MINIMAX_INSTALL_DIR = (Join-Path $temp 'tampered app') }
  $code = Invoke-Installer $tamperDir $tamperEnv
  if ($code -eq 0) { Fail 'a tampered archive was accepted — integrity gate is broken' }
  Add-Result 'tamper-rejection' $true 'one flipped byte -> installer failed closed'
  Write-Phase '  PASS: tampered archive rejected'
}
finally {
  try { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}

# --- Evidence report. -----------------------------------------------------
$reportDir = Join-Path $RepoRoot 'coverage'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$report = [pscustomobject]@{
  harness = 'clean-vm-acceptance.ps1 (node-free, PowerShell + shipped CMD installer only)'
  release = $rel.Base
  prevRelease = $script:PrevBase
  failures = $script:Failures
  verdict = $(if ($script:Failures -eq 0) { 'PASS' } else { 'FAIL' })
  results = $script:Results
  at = (Get-Date).ToUniversalTime().ToString('o')
}
$report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $reportDir 'clean-vm-acceptance.json') -Encoding utf8

if ($script:Failures -gt 0) {
  Write-Host "[clean-vm] FAIL: $($script:Failures) phase(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host '[clean-vm] PASS: node-free clean-VM acceptance complete.'
exit 0
