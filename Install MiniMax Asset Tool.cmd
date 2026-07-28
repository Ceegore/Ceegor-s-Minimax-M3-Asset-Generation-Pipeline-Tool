@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Install MiniMax Asset Tool
cd /d "%~dp0"

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
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%" >nul 2>&1
if not exist "%INSTALL_DIR%" (
  echo [ERROR] Windows could not create the installation folder.
  echo Close this window, move the extracted release to a normal folder,
  echo and try again. Administrator access should not be needed.
  pause
  exit /b 1
)

robocopy "%SOURCE_DIR%" "%INSTALL_DIR%" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS
set "COPY_RESULT=%ERRORLEVEL%"
if %COPY_RESULT% GEQ 8 (
  echo.
  echo [ERROR] Windows could not copy all application files.
  echo Robocopy exit code: %COPY_RESULT%
  echo Check that there is at least 4 GB of free disk space and try again.
  pause
  exit /b 1
)

:shortcuts
if not exist "%INSTALL_DIR%\MiniMaxAssetTool.exe" goto :copy_incomplete
if not exist "%INSTALL_DIR%\resources\app.asar" goto :copy_incomplete
if not exist "%INSTALL_DIR%\resources\bin\models\birefnet-general.onnx" goto :copy_incomplete
if not exist "%INSTALL_DIR%\resources\bin\models\lama-big.onnx" goto :copy_incomplete
if not exist "%INSTALL_DIR%\resources\bin\realesrgan-ncnn-vulkan.exe" goto :copy_incomplete

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
for %%F in ("%SOURCE_DIR%\MiniMaxAssetTool-*-x64.zip.001") do if exist "%%~fF" if not defined ARCHIVE_FIRST set "ARCHIVE_FIRST=%%~fF"
for %%F in ("%SOURCE_DIR%\MiniMaxAssetTool-*-x64.zip") do if exist "%%~fF" if not defined ARCHIVE_FIRST set "ARCHIVE_FIRST=%%~fF"
if not defined ARCHIVE_FIRST goto :missing

if not defined TEMP goto :no_temp
set "EXTRACT_DIR=%TEMP%\MiniMaxAssetTool-install-%RANDOM%-%RANDOM%"
if exist "%EXTRACT_DIR%" goto :temp_collision
mkdir "%EXTRACT_DIR%" >nul 2>&1
if not exist "%EXTRACT_DIR%" goto :no_temp

echo Verifying all download parts and preparing the installer...
set "MINIMAX_ARCHIVE_FIRST=%ARCHIVE_FIRST%"
set "MINIMAX_EXTRACT_DIR=%EXTRACT_DIR%"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $first=[IO.Path]::GetFullPath($env:MINIMAX_ARCHIVE_FIRST); $dir=[IO.Path]::GetDirectoryName($first); $isSplit=$first.EndsWith('.001',[StringComparison]::OrdinalIgnoreCase); $base=if($isSplit){$first.Substring(0,$first.Length-4)}else{$first}; $baseName=[IO.Path]::GetFileName($base); $manifest=$base+'.sha256'; if(-not [IO.File]::Exists($manifest)){throw 'The matching .zip.sha256 file is missing.'}; $parts=if($isSplit){@(Get-ChildItem -LiteralPath $dir -File | Where-Object {$_.Name -match ('^'+[regex]::Escape($baseName)+'\.\d{3}$')} | Sort-Object Name)}else{@(Get-Item -LiteralPath $first)}; if($parts.Count -eq 0){throw 'No archive parts were found.'}; if($isSplit){for($i=0;$i -lt $parts.Count;$i++){ $expected=$baseName+'.'+('{0:D3}' -f ($i+1)); if($parts[$i].Name -ne $expected){throw ('Archive sequence is incomplete. Expected '+$expected+'.')} }}; $hashes=@{}; foreach($line in [IO.File]::ReadAllLines($manifest)){if($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$'){$hashes[$matches[2].Trim()]=$matches[1].ToLowerInvariant()}}; foreach($part in $parts){if(-not $hashes.ContainsKey($part.Name)){throw ('No checksum was published for '+$part.Name+'.')}; $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $part.FullName).Hash.ToLowerInvariant(); if($actual -ne $hashes[$part.Name]){throw ('Checksum mismatch for '+$part.Name+'. Download that file again.')}}; $joined=Join-Path $env:MINIMAX_EXTRACT_DIR 'release.zip'; $output=[IO.File]::Create($joined); try{foreach($part in $parts){$input=[IO.File]::OpenRead($part.FullName); try{$input.CopyTo($output)}finally{$input.Dispose()}}}finally{$output.Dispose()}"
if errorlevel 1 goto :extract_failed

where tar.exe >nul 2>&1
if errorlevel 1 goto :no_tar
tar.exe -xf "%EXTRACT_DIR%\release.zip" -C "%EXTRACT_DIR%"
if errorlevel 1 goto :extract_failed
if not exist "%EXTRACT_DIR%\win-unpacked\Install MiniMax Asset Tool.cmd" goto :extract_failed

call "%EXTRACT_DIR%\win-unpacked\Install MiniMax Asset Tool.cmd"
set "INSTALL_RESULT=%ERRORLEVEL%"
rmdir /s /q "%EXTRACT_DIR%"
exit /b %INSTALL_RESULT%

:missing
echo [ERROR] This does not look like a complete extracted release.
echo Keep this installer beside MiniMaxAssetTool.exe and the resources folder.
echo Or keep it beside every numbered release archive part and the .zip.sha256 file.
pause
exit /b 1

:extract_failed
echo.
echo [ERROR] Windows could not verify or extract the complete release.
echo Make sure this installer, every numbered archive part, and the matching
echo .zip.sha256 file are together in one folder, then try again.
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

:no_local_app_data
echo [ERROR] Windows did not provide a per-user application folder.
echo Contact your computer administrator for help.
pause
exit /b 1
