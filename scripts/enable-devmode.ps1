# scripts/enable-devmode.ps1
# One-time Windows setup that grants the symlink privilege
# electron-builder needs to extract winCodeSign.
#
# What it does:
#   - Sets the AllowDevelopmentWithoutDevLicense registry value
#     to 1 under HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\
#     AppModelUnlock. This is the same key that "Windows Developer
#     Mode" toggles in the Settings UI. It grants the current
#     user (and all future users) the SeCreateSymbolicLinkPrivilege
#     so processes running as that user can create symbolic links
#     without admin elevation.
#
#   - No reboot required; the privilege is picked up the next
#     time the user signs in or starts a new process.
#
# Run from an admin PowerShell (or click Yes on the UAC prompt):
#   powershell -ExecutionPolicy Bypass -File scripts/enable-devmode.ps1
#
# Idempotent: re-running is a no-op. Safe to share with the team.

$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$name = 'AllowDevelopmentWithoutDevLicense'

# Self-elevate if we're not already admin. The UAC prompt is the
# only "interaction" the user sees; the script then runs silently.
if (-not (New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Re-launching as administrator..."
    $script = $MyInvocation.MyCommand.Path
    Start-Process -FilePath "powershell" -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$script`""
    ) -Verb RunAs
    exit 0
}

if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
}
Set-ItemProperty -Path $key -Name $name -Value 1 -Type DWord

Write-Host ""
Write-Host "Windows Developer Mode is now ENABLED."
Write-Host "  - SeCreateSymbolicLinkPrivilege granted to your user."
Write-Host "  - electron-builder can now extract the winCodeSign"
Write-Host "    archive without the symlink permission error."
Write-Host ""
Write-Host "You can now run:"
Write-Host "  npm run build"
Write-Host ""
Write-Host "(If you still see the error, sign out and back in once so"
Write-Host " the new privilege is picked up by your existing shell.)"
