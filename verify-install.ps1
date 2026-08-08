# verify-install.ps1 — self-check for an extracted MiniMax Asset Tool release.
#
# Verifies every file of this installation against the shipped FILES.sha256
# inventory and tells you exactly what is missing or damaged. Pure
# PowerShell — no Node.js or other tools required.
#
# Usage: right-click -> "Run with PowerShell", or from a terminal:
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-install.ps1
#
# Exit codes: 0 = installation complete and intact, 1 = problems found.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $root 'FILES.sha256'

Write-Host ''
Write-Host 'MiniMax Asset Tool — installation self-check'
Write-Host '============================================='
Write-Host ''

if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Host 'FAILED: FILES.sha256 is missing from this folder.' -ForegroundColor Red
    Write-Host 'This folder is not a complete release installation. Re-download'
    Write-Host 'the release archives and extract ALL of them into one folder.'
    exit 1
}

$ok = 0
$missing = @()
$mismatch = @()

foreach ($line in Get-Content -LiteralPath $manifest) {
    if (-not $line.Trim()) { continue }
    $idx = $line.IndexOf('  ')
    if ($idx -lt 1) { continue }
    $expected = $line.Substring(0, $idx).Trim().ToLowerInvariant()
    $rel = $line.Substring($idx + 2).Trim().Replace('/', '\')
    $p = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $p)) {
        $missing += $rel
        continue
    }
    $actual = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { $mismatch += $rel } else { $ok++ }
}

Write-Host ("Files verified OK : {0}" -f $ok)
Write-Host ("Files missing     : {0}" -f $missing.Count)
Write-Host ("Files damaged     : {0}" -f $mismatch.Count)
Write-Host ''

if ($missing.Count -eq 0 -and $mismatch.Count -eq 0) {
    Write-Host 'RESULT: OK — the installation is complete and intact.' -ForegroundColor Green
    Write-Host 'You can start the application with MiniMaxAssetTool.exe.'
    exit 0
}

if ($missing.Count -gt 0) {
    Write-Host 'MISSING FILES:' -ForegroundColor Yellow
    foreach ($m in $missing) { Write-Host "  $m" }
    Write-Host ''
    Write-Host 'The release is distributed as split archives (.part1.zip,'
    Write-Host '.part2.zip, ...). Every part must be extracted into the SAME'
    Write-Host 'folder. Missing files almost always mean that one of the part'
    Write-Host 'archives was not extracted (or was extracted somewhere else).'
    Write-Host 'Extract ALL part archives into this folder and run this check'
    Write-Host 'again.'
    Write-Host ''
    if (($missing -contains 'snapshot_blob.bin') -or ($missing -contains 'v8_context_snapshot.bin')) {
        Write-Host 'NOTE: without the V8 snapshot files the application cannot'
        Write-Host 'start at all and fails silently. Fix the extraction first.'
        Write-Host ''
    }
}

if ($mismatch.Count -gt 0) {
    Write-Host 'DAMAGED FILES (hash mismatch — re-download, do NOT run the app):' -ForegroundColor Red
    foreach ($m in $mismatch) { Write-Host "  $m" }
    Write-Host ''
}

Write-Host 'RESULT: FAILED — see the messages above.' -ForegroundColor Red
exit 1
