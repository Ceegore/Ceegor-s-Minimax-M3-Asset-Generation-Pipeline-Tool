$t = $null; $e = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot '..\scripts\acceptance\clean-vm-acceptance.ps1'),
  [ref]$t, [ref]$e) | Out-Null
if ($e.Count) { $e | ForEach-Object { Write-Host $_.Message }; exit 1 }
Write-Host 'PS1 SYNTAX OK'
