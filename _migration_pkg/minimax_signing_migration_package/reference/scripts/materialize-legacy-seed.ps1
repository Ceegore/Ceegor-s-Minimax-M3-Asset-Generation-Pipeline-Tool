param(
  [Parameter(Mandatory=$true)][string]$DownloadDir,
  [Parameter(Mandatory=$true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$DownloadDir = [IO.Path]::GetFullPath($DownloadDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (-not (Test-Path -LiteralPath $DownloadDir)) { throw "Download directory not found: $DownloadDir" }
Remove-Item -LiteralPath $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDir | Out-Null

$single = Get-ChildItem -LiteralPath $DownloadDir -File | Where-Object { $_.Name -match '^MiniMaxAssetTool-.+-x64\.zip$' } | Sort-Object Name | Select-Object -First 1
$independentPart1 = Get-ChildItem -LiteralPath $DownloadDir -File | Where-Object { $_.Name -match '^MiniMaxAssetTool-.+-x64\.part1\.zip$' } | Sort-Object Name | Select-Object -First 1
$rawPart1 = Get-ChildItem -LiteralPath $DownloadDir -File | Where-Object { $_.Name -match '^MiniMaxAssetTool-.+-x64\.zip\.001$' } | Sort-Object Name | Select-Object -First 1

if ($single) {
  & tar.exe -xf $single.FullName -C $OutputDir
  if ($LASTEXITCODE -ne 0) { throw "Could not extract $($single.Name)" }
}
elseif ($independentPart1) {
  $base = $independentPart1.Name -replace '\.part1\.zip$',''
  $parts = Get-ChildItem -LiteralPath $DownloadDir -File |
    Where-Object { $_.Name -match ('^' + [regex]::Escape($base) + '\.part\d+\.zip$') } |
    Sort-Object { [int][regex]::Match($_.Name, '\.part(\d+)\.zip$').Groups[1].Value }
  for ($i = 0; $i -lt $parts.Count; $i++) {
    $expected = "$base.part$($i + 1).zip"
    if ($parts[$i].Name -ne $expected) { throw "Independent ZIP sequence is incomplete. Expected $expected" }
    & tar.exe -xf $parts[$i].FullName -C $OutputDir
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $($parts[$i].Name)" }
  }
}
elseif ($rawPart1) {
  $base = $rawPart1.Name -replace '\.001$',''
  $parts = Get-ChildItem -LiteralPath $DownloadDir -File |
    Where-Object { $_.Name -match ('^' + [regex]::Escape($base) + '\.\d{3}$') } |
    Sort-Object Name
  for ($i = 0; $i -lt $parts.Count; $i++) {
    $expected = "$base.$('{0:D3}' -f ($i + 1))"
    if ($parts[$i].Name -ne $expected) { throw "Raw ZIP sequence is incomplete. Expected $expected" }
  }
  $joined = Join-Path $env:RUNNER_TEMP 'legacy-release-joined.zip'
  Remove-Item -LiteralPath $joined -Force -ErrorAction SilentlyContinue
  $output = [IO.File]::Create($joined)
  try {
    foreach ($part in $parts) {
      $input = [IO.File]::OpenRead($part.FullName)
      try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
  } finally { $output.Dispose() }
  & tar.exe -xf $joined -C $OutputDir
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract joined raw ZIP' }
}
else { throw "No supported release archive found in $DownloadDir" }

$candidate = Get-ChildItem -LiteralPath $OutputDir -Recurse -File -Filter MiniMaxAssetTool.exe |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources\app.asar') } |
  Select-Object -First 1
if (-not $candidate) { throw 'Could not locate MiniMaxAssetTool.exe plus resources\app.asar' }
"seed_path=$($candidate.DirectoryName)" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
Write-Host "Legacy seed located: $($candidate.DirectoryName)"
