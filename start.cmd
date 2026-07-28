@echo off
REM ============================================================
REM MiniMax Assets Tool - Launcher
REM ============================================================
REM Phase 4 Fix 12: Trailing-backslash-Fix fuer Pfade mit Leerzeichen.
REM
REM Launches the app via the OFFICIAL Electron runtime from node_modules
REM (the same electron.exe shipped with the electron npm package). This
REM binary is the upstream Electron build and is NOT code-signed by
REM Microsoft or by this project — it is unsigned. Windows SmartScreen /
REM Defender / your antivirus may therefore still show a reputation
REM prompt the first time you run it. That is expected for an unsigned
REM portable build; choose "More info" → "Run anyway" to proceed.
REM ============================================================

setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM Pfad OHNE trailing backslash (vermeidet Quoting-Bug bei Pfaden
REM mit Leerzeichen wie "C:\Projects 1\..."):
REM   %~dp0.  (der Punkt strippt den letzten Backslash)
set "ROOT_DIR=%~dp0."

REM Electron runtime from node_modules. It is not a guarantee against
REM SmartScreen, Defender, AppLocker, or organization-specific policies.
set "ELECTRON_BIN=%ROOT_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_BIN%" (
  echo FEHLER: Electron-Binary nicht gefunden:
  echo   %ELECTRON_BIN%
  echo Bitte zuerst ausfuehren: npm install
  pause
  exit /b 1
)

echo Starte MiniMax Assets Tool...
echo   Pfad: %ROOT_DIR%
echo   Electron: %ELECTRON_BIN%
"%ELECTRON_BIN%" "%ROOT_DIR%" %*
endlocal
