param()
$ErrorActionPreference = 'Stop'
if (-not $env:GITHUB_ENV -or -not $env:GITHUB_PATH -or -not $env:RUNNER_TEMP) { throw 'Must run inside GitHub Actions.' }
if (-not $env:MINISIGN_KEY_B64) { throw 'MINISIGN_KEY_B64 is missing.' }
if (-not $env:MINISIGN_PUB_KEY) { throw 'MINISIGN_PUB_KEY is missing.' }
$url = 'https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-win64.zip'
$expected = 'B9C31C2C3034F81F0E5F5D92CBCC20E67A9671B6E5455661588638848DC58031'
$zip = Join-Path $env:RUNNER_TEMP 'minisign-0.11-win64.zip'
$toolDir = Join-Path $env:RUNNER_TEMP 'minisign-0.11'
Invoke-WebRequest -Uri $url -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
if ($actual -ne $expected) { throw "Pinned Minisign hash mismatch: expected $expected, got $actual" }
Remove-Item -LiteralPath $toolDir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zip -DestinationPath $toolDir
$exe = Get-ChildItem -LiteralPath $toolDir -Recurse -File -Filter minisign.exe | Select-Object -First 1
if (-not $exe) { throw 'Pinned archive contains no minisign.exe.' }
$keyPath = Join-Path $env:RUNNER_TEMP 'minisign.key'
$pubPath = Join-Path $env:RUNNER_TEMP 'minisign.pub'
[IO.File]::WriteAllBytes($keyPath, [Convert]::FromBase64String($env:MINISIGN_KEY_B64))
Set-Content -LiteralPath $pubPath -Value $env:MINISIGN_PUB_KEY -Encoding ascii
Add-Content -LiteralPath $env:GITHUB_PATH -Value $exe.DirectoryName
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MINISIGN_TOOL_PATH=$($exe.FullName)"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MINISIGN_KEY_PATH=$keyPath"
Add-Content -LiteralPath $env:GITHUB_ENV -Value "MINISIGN_PUB_PATH=$pubPath"
& $exe.FullName -v
if ($LASTEXITCODE -ne 0) { throw 'Pinned Minisign version check failed.' }
Write-Host 'Pinned Minisign prepared outside the repository worktree.'
