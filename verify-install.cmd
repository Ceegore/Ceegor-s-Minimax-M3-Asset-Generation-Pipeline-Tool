@echo off
rem verify-install.cmd — start the installation self-check.
rem Verifies every file of this folder against FILES.sha256.
rem Works without Node.js; uses only built-in Windows PowerShell.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-install.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo VERIFY-INSTALL: OK
) else (
  echo VERIFY-INSTALL: FAILED - read the messages above.
)
pause
exit /b %RC%
