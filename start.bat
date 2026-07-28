@echo off
setlocal
title MiniMax Asset Generation Pipeline Tool
cd /d "%~dp0"

echo.
echo ============================================================
echo   MiniMax Asset Generation Pipeline Tool
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [error] Node.js was not found on PATH.
  echo         Install Node.js 22.12+ from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [setup] Installing dependencies, first run...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [error] npm install failed. Check your network connection.
    pause
    exit /b 1
  )
)

if not exist "config.txt" (
  copy /Y "config.txt.example" "config.txt" >nul
  echo.
  echo   *** Open config.txt and paste your MiniMax Token Plan API key. ***
  echo   *** Then run start.bat again.                            ***
  echo.
  pause
  exit /b 0
)

echo [start] Launching...
node_modules\.bin\electron.cmd .
set EXITCODE=%errorlevel%
echo [exit] App closed with code %EXITCODE%.
if not "%EXITCODE%"=="0" pause
endlocal
