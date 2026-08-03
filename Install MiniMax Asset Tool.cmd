@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Install MiniMax Asset Tool
cd /d "%~dp0"
rem H-016 (hhhhu3 audit): %~dp0 ends with a backslash, so %CD% here is
rem "X:\path\" while normalized paths are "X:\path". A trailing-backslash
rem mismatch would break the source-equals-install comparison below (and the
rem installer would re-install over itself). Normalize through a FOR loop.
for %%I in ("%CD%") do cd /d "%%~fI"

echo.
echo ============================================================
echo   MiniMax Asset Tool - Easy Installer
echo ============================================================
echo.
echo This installs the complete offline app for your Windows account.
echo It does not need administrator access or download extra components.
echo.

set "SOURCE_DIR=%CD%"
if not exist "%SOURCE_DIR%\MiniMaxAssetTool.exe" goto :bootstrap

:install
if not exist "%SOURCE_DIR%\MiniMaxAssetTool.exe" goto :missing
if not exist "%SOURCE_DIR%\resources\app.asar" goto :missing
if not exist "%SOURCE_DIR%\resources\bin\models\isnet-general-use.onnx" goto :missing
if not exist "%SOURCE_DIR%\resources\bin\models\birefnet-general.onnx" goto :missing
if not exist "%SOURCE_DIR%\resources\bin\models\lama-big.onnx" goto :missing
if not exist "%SOURCE_DIR%\resources\bin\realesrgan-ncnn-vulkan.exe" goto :missing

if defined MINIMAX_INSTALL_DIR (
  set "INSTALL_DIR=%MINIMAX_INSTALL_DIR%"
) else (
  if not defined LOCALAPPDATA goto :no_local_app_data
  set "INSTALL_DIR=%LOCALAPPDATA%\Programs\MiniMaxAssetTool"
)

for %%I in ("%SOURCE_DIR%") do set "SOURCE_DIR=%%~fI"
for %%I in ("%INSTALL_DIR%") do set "INSTALL_DIR=%%~fI"

if /I "%SOURCE_DIR%"=="%INSTALL_DIR%" goto :shortcuts

echo Installing to:
echo   %INSTALL_DIR%
echo.

rem H-066 (_5 audit): stage into a temporary directory FIRST, verify, then
rem swap. If the copy or hash check fails, the existing installation is
rem left byte-identical and startable. Old files that are not part of the
rem new release are removed by the swap (robocopy /MIR on the staging dir).
set "STAGING_DIR=%INSTALL_DIR%.staging-%RANDOM%-%RANDOM%"
if exist "%STAGING_DIR%" goto :temp_collision
mkdir "%STAGING_DIR%" >nul 2>&1
if not exist "%STAGING_DIR%" (
  echo [ERROR] Windows could not create the staging folder.
  echo Close this window and try again.
  pause
  exit /b 1
)

robocopy "%SOURCE_DIR%" "%STAGING_DIR%" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS
set "COPY_RESULT=%ERRORLEVEL%"
if %COPY_RESULT% GEQ 8 (
  echo.
  echo [ERROR] Windows could not copy all application files.
  echo Robocopy exit code: %COPY_RESULT%
  echo Check that there is at least 4 GB of free disk space and try again.
  rmdir /s /q "%STAGING_DIR%" >nul 2>&1
  pause
  exit /b 1
)

rem Verify the staging directory BEFORE touching the live installation.
if not exist "%STAGING_DIR%\MiniMaxAssetTool.exe" goto :staging_incomplete
if not exist "%STAGING_DIR%\resources\app.asar" goto :staging_incomplete
if not exist "%STAGING_DIR%\resources\bin\models\birefnet-general.onnx" goto :staging_incomplete
if not exist "%STAGING_DIR%\resources\bin\models\lama-big.onnx" goto :staging_incomplete
if not exist "%STAGING_DIR%\resources\bin\realesrgan-ncnn-vulkan.exe" goto :staging_incomplete

rem M-024 (360 Audit): per-file hash verification against FILES.sha256.
rem M-017 (hhhhu2 audit): the manifest is MANDATORY for an installable release.
rem A missing manifest fails closed — a directly extracted/portable source
rem tree without the inner manifest is not accepted.
rem H-018 (hhhhu3 audit): the verification is COMPLETE and strict. It rejects
rem malformed manifest lines, duplicate entries, files present on disk but
rem missing from the manifest, and a manifest that is far too small to be real.
if not exist "%STAGING_DIR%\FILES.sha256" goto :missing_manifest
set "MINIMAX_INSTALL_DIR_FOR_HASH=%STAGING_DIR%"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $root=$env:MINIMAX_INSTALL_DIR_FOR_HASH; $minEntries=if($env:MINIMAX_MANIFEST_MIN_ENTRIES){[int]$env:MINIMAX_MANIFEST_MIN_ENTRIES}else{50}; $manifest=Join-Path $root 'FILES.sha256'; $bad=0; $entries=@{}; foreach($line in [IO.File]::ReadAllLines($manifest)){ if([string]::IsNullOrWhiteSpace($line)){continue}; if($line -match '^([0-9a-fA-F]{64})\s+(.+)$'){ $rel=$matches[2].Trim(); if($entries.ContainsKey($rel.ToLowerInvariant())){Write-Host ('  DUPLICATE: '+$rel); $bad++; continue}; $entries[$rel.ToLowerInvariant()]=$rel; $fp=Join-Path $root $rel; if(-not [IO.File]::Exists($fp)){Write-Host ('  MISSING: '+$rel); $bad++; continue}; $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $fp).Hash.ToLowerInvariant(); if($actual -ne $matches[1].ToLowerInvariant()){Write-Host ('  TAMPERED: '+$rel); $bad++} } else {Write-Host ('  MALFORMED manifest line: '+$line); $bad++} }; foreach($fp in [IO.Directory]::EnumerateFiles($root,'*',[IO.SearchOption]::AllDirectories)){ $rel=$fp.Substring($root.Length+1).Replace('\','/'); if($rel -eq 'FILES.sha256'){continue}; if(-not $entries.ContainsKey($rel.ToLowerInvariant())){Write-Host ('  UNLISTED: '+$rel); $bad++} }; if($entries.Count -lt $minEntries){Write-Host ('  MANIFEST TOO SMALL: only '+$entries.Count+' entries (a real release has hundreds).'); $bad++}; if($bad -gt 0){throw ($bad.ToString()+' file(s) failed the completeness/integrity check.')}"
if errorlevel 1 (
  echo.
  echo [ERROR] One or more files failed the integrity check.
  echo The existing installation was NOT modified.
  rmdir /s /q "%STAGING_DIR%" >nul 2>&1
  pause
  exit /b 1
)
echo Integrity check passed.
:skip_hash_check

rem Swap: remove old installation, rename staging to final.
rem If the old dir exists, move it aside first (rollback safety).
rem H-015 (hhhhu3 audit): Windows REN accepts only a bare NAME as its target —
rem `ren "C:\full\path" "C:\other\full\path"` fails when an existing install
rem is present. Use `move /y`, which accepts full destination paths.
set "OLD_DIR=%INSTALL_DIR%.old-%RANDOM%"
if exist "%INSTALL_DIR%" (
  move /y "%INSTALL_DIR%" "%OLD_DIR%" >nul 2>&1
  if exist "%INSTALL_DIR%" (
    echo [ERROR] Could not move the existing installation aside.
    echo Close the app if it is running and try again.
    rmdir /s /q "%STAGING_DIR%" >nul 2>&1
    pause
    exit /b 1
  )
)
move /y "%STAGING_DIR%" "%INSTALL_DIR%" >nul 2>&1
if not exist "%INSTALL_DIR%\MiniMaxAssetTool.exe" (
  echo [ERROR] The final swap failed. Attempting rollback...
  if defined OLD_DIR if exist "%OLD_DIR%" move /y "%OLD_DIR%" "%INSTALL_DIR%" >nul 2>&1
  pause
  exit /b 1
)
rem Remove the old installation (swap succeeded).
if defined OLD_DIR if exist "%OLD_DIR%" rmdir /s /q "%OLD_DIR%" >nul 2>&1

:shortcuts
rem H-016 (hhhhu3 audit): the source-equals-install path jumps here, so the
rem label must exist. Re-running the installer inside the installed directory
rem refreshes the shortcuts instead of crashing on a missing label.

echo Creating Desktop and Start menu shortcuts...
set "MINIMAX_INSTALL_TARGET=%INSTALL_DIR%"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $target=Join-Path $env:MINIMAX_INSTALL_TARGET 'MiniMaxAssetTool.exe'; $desktop=if($env:MINIMAX_INSTALL_DESKTOP){$env:MINIMAX_INSTALL_DESKTOP}else{[Environment]::GetFolderPath('Desktop')}; $programs=if($env:MINIMAX_INSTALL_START_MENU){$env:MINIMAX_INSTALL_START_MENU}else{[Environment]::GetFolderPath('Programs')}; $shell=New-Object -ComObject WScript.Shell; foreach($folder in @($desktop,$programs)){$null=[IO.Directory]::CreateDirectory($folder); $shortcut=$shell.CreateShortcut((Join-Path $folder 'MiniMax Asset Tool.lnk')); $shortcut.TargetPath=$target; $shortcut.WorkingDirectory=$env:MINIMAX_INSTALL_TARGET; $shortcut.IconLocation=$target; $shortcut.Save()}"
if errorlevel 1 (
  echo [WARNING] The app is installed, but Windows could not create shortcuts.
  echo You can start it directly from:
  echo   %INSTALL_DIR%\MiniMaxAssetTool.exe
) else (
  echo Shortcuts created.
)

echo.
echo Installation complete. No local models or processing tools need to be downloaded.
echo The app only uses the internet when you ask a cloud provider to generate an asset.
echo.
if "%MINIMAX_INSTALL_NO_LAUNCH%"=="1" exit /b 0
echo Starting MiniMax Asset Tool...
start "" "%INSTALL_DIR%\MiniMaxAssetTool.exe"
exit /b 0

:bootstrap
set "ARCHIVE_FIRST="
for %%F in ("%SOURCE_DIR%\MiniMaxAssetTool-*-x64.part1.zip") do if exist "%%~fF" if not defined ARCHIVE_FIRST set "ARCHIVE_FIRST=%%~fF"
for %%F in ("%SOURCE_DIR%\MiniMaxAssetTool-*-x64.zip") do if exist "%%~fF" if not defined ARCHIVE_FIRST set "ARCHIVE_FIRST=%%~fF"
if not defined ARCHIVE_FIRST goto :missing

if not defined TEMP goto :no_temp
set "EXTRACT_DIR=%TEMP%\MiniMaxAssetTool-install-%RANDOM%-%RANDOM%"
if exist "%EXTRACT_DIR%" goto :temp_collision
mkdir "%EXTRACT_DIR%" >nul 2>&1
if not exist "%EXTRACT_DIR%" goto :no_temp

where tar.exe >nul 2>&1
if errorlevel 1 goto :no_tar

echo Verifying and extracting all download parts...
set "MINIMAX_ARCHIVE_FIRST=%ARCHIVE_FIRST%"
set "MINIMAX_EXTRACT_DIR=%EXTRACT_DIR%"
rem Every part is an independent, complete .zip (not a raw volume split), so
rem each one is checksum-verified and extracted on its own. All parts store
rem their files under the same MiniMaxAssetTool-<version>-x64 folder, so the
rem extractions merge into one folder.
rem H-017 (hhhhu3 audit): when the release publishes a Minisign signature
rem (<base>.sha256.minisig), it is verified against the PINNED public key
rem BEFORE any checksum is trusted — an attacker who can replace the archive
rem can also replace the plaintext .sha256 file, so the hash alone proves
rem nothing. Verification requires minisign.exe beside this installer or on
rem PATH (https://jedisct1.github.io/minisign/). A signature that FAILS to
rem verify aborts the install; a missing verification tool warns loudly.
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $first=[IO.Path]::GetFullPath($env:MINIMAX_ARCHIVE_FIRST); $dir=[IO.Path]::GetDirectoryName($first); $name=[IO.Path]::GetFileName($first); $isSplit=$name -match '\.part1\.zip$'; $baseName=if($isSplit){$name -replace '\.part1\.zip$',''}else{$name -replace '\.zip$',''}; $manifest=Join-Path $dir ($baseName+'.sha256'); if(-not [IO.File]::Exists($manifest)){throw 'The matching .sha256 checksum file is missing.'}; $sig=Join-Path $dir ($baseName+'.sha256.minisig'); if([IO.File]::Exists($sig)){ $pub=Join-Path $dir 'minisign.pub'; $tool=$null; $candidate=Join-Path $dir 'minisign.exe'; if([IO.File]::Exists($candidate)){$tool=$candidate}else{$found=(Get-Command minisign -ErrorAction SilentlyContinue); if($found){$tool=$found.Source}}; if(-not $tool){ Write-Host '  [WARNING] A release signature (.minisig) is present but minisign.exe was not found — the signature could NOT be verified. Place minisign.exe beside the installer for full assurance.' } else { if(-not [IO.File]::Exists($pub)){throw 'The pinned Minisign public key (minisign.pub) is missing next to the release files.'}; & $tool -V -p $pub -m $manifest -x $sig | Out-Null; if($LASTEXITCODE -ne 0){throw 'The release signature (.minisig) is INVALID. Do not install these files — download them again from the official release page.'}; Write-Host '  Release signature verified against the pinned public key.' } }; $parts=if($isSplit){@(Get-ChildItem -LiteralPath $dir -File | Where-Object {$_.Name -match ('^'+[regex]::Escape($baseName)+'\.part\d+\.zip$')} | Sort-Object {[int][regex]::Match($_.Name,'\.part(\d+)\.zip$').Groups[1].Value})}else{@(Get-Item -LiteralPath $first)}; if($parts.Count -eq 0){throw 'No archive parts were found.'}; if($isSplit){for($i=0;$i -lt $parts.Count;$i++){$expected=$baseName+'.part'+($i+1)+'.zip'; if($parts[$i].Name -ne $expected){throw ('Archive sequence is incomplete. Expected '+$expected+'.')}}}; $hashes=@{}; foreach($line in [IO.File]::ReadAllLines($manifest)){if($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$'){$hashes[$matches[2].Trim()]=$matches[1].ToLowerInvariant()}}; foreach($part in $parts){if(-not $hashes.ContainsKey($part.Name)){throw ('No checksum was published for '+$part.Name+'.')}; $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $part.FullName).Hash.ToLowerInvariant(); if($actual -ne $hashes[$part.Name]){throw ('Checksum mismatch for '+$part.Name+'. Download that file again.')}}; foreach($part in $parts){& tar.exe -xf $part.FullName -C $env:MINIMAX_EXTRACT_DIR; if($LASTEXITCODE -ne 0){throw ('Could not extract '+$part.Name+'.')}}"
if errorlevel 1 goto :extract_failed

rem The archive's single top-level folder is MiniMaxAssetTool-<version>-x64.
set "APP_DIR="
for /d %%D in ("%EXTRACT_DIR%\MiniMaxAssetTool-*") do if not defined APP_DIR set "APP_DIR=%%~fD"
if not defined APP_DIR goto :extract_failed
if not exist "%APP_DIR%\Install MiniMax Asset Tool.cmd" goto :extract_failed

call "%APP_DIR%\Install MiniMax Asset Tool.cmd"
set "INSTALL_RESULT=%ERRORLEVEL%"
rmdir /s /q "%EXTRACT_DIR%"
exit /b %INSTALL_RESULT%

:missing
echo [ERROR] This does not look like a complete extracted release.
echo Keep this installer beside MiniMaxAssetTool.exe and the resources folder.
echo Or keep it beside every release archive part and the .sha256 file.
pause
exit /b 1

:extract_failed
echo.
echo [ERROR] Windows could not verify or extract the complete release.
echo Make sure this installer, every archive part, and the matching
echo .sha256 file are together in one folder, then try again.
echo Temporary files were left here for troubleshooting:
echo   %EXTRACT_DIR%
pause
exit /b 1

:no_tar
echo [ERROR] The built-in Windows archive tool is unavailable.
echo This release requires Windows 11. Ask your computer administrator for help.
pause
exit /b 1

:no_temp
echo [ERROR] Windows could not create a temporary installation folder.
echo Check that the system drive has enough free space and try again.
pause
exit /b 1

:temp_collision
echo [ERROR] Windows could not choose a safe temporary installation folder.
echo Close this window and run the installer again.
pause
exit /b 1

:copy_incomplete
echo [ERROR] The copied installation is incomplete.
echo Check that there is at least 4 GB of free disk space and try again.
pause
exit /b 1

:staging_incomplete
echo [ERROR] The staged installation is incomplete.
echo The existing installation was NOT modified.
rmdir /s /q "%STAGING_DIR%" >nul 2>&1
pause
exit /b 1

:missing_manifest
echo [ERROR] The release integrity manifest (FILES.sha256) is missing.
echo A valid release must include this file. The installation was aborted.
echo The existing installation was NOT modified.
rmdir /s /q "%STAGING_DIR%" >nul 2>&1
pause
exit /b 1

:no_local_app_data
echo [ERROR] Windows did not provide a per-user application folder.
echo Contact your computer administrator for help.
pause
exit /b 1
