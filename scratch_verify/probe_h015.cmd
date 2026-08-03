@echo off
rem scratch_verify\probe_h015.cmd — hands-on proof for H-015
setlocal EnableExtensions
set "ROOT=%TEMP%\h015probe"
rmdir /s /q "%ROOT%" 2>nul
mkdir "%ROOT%\install_dir"
mkdir "%ROOT%\staging_dir"
mkdir "%ROOT%\old_probe"
echo old > "%ROOT%\install_dir\old_file.txt"
echo new > "%ROOT%\staging_dir\MiniMaxAssetTool.exe"

rem ---- 1. the OLD broken form: REN with a full destination path ----
set "INSTALL_DIR=%ROOT%\install_dir"
set "OLD_DIR=%ROOT%\old_probe"
ren "%INSTALL_DIR%" "%OLD_DIR%" >nul 2>&1
if exist "%ROOT%\old_probe\old_file.txt" (
  echo RESULT-REN-FULLPATH=succeeded
) else (
  echo RESULT-REN-FULLPATH=failed-as-audited
)
rem restore state for the shipped-form test (ren may have partially acted)
if not exist "%INSTALL_DIR%" if exist "%ROOT%\old_probe\old_file.txt" move /y "%OLD_DIR%" "%INSTALL_DIR%" >nul 2>&1

rem ---- 2. the SHIPPED swap logic (verbatim from the installer) ----
set "OLD_DIR=%INSTALL_DIR%.old-%RANDOM%"
if exist "%INSTALL_DIR%" (
  move /y "%INSTALL_DIR%" "%OLD_DIR%" >nul 2>&1
  if exist "%INSTALL_DIR%" (
    echo RESULT-SWAP=move-aside-failed
    goto :done
  )
)
move /y "%ROOT%\staging_dir" "%INSTALL_DIR%" >nul 2>&1
if not exist "%INSTALL_DIR%\MiniMaxAssetTool.exe" (
  echo RESULT-SWAP=swap-failed
  if defined OLD_DIR if exist "%OLD_DIR%" move /y "%OLD_DIR%" "%INSTALL_DIR%" >nul 2>&1
  goto :done
)
echo RESULT-SWAP=success
if exist "%INSTALL_DIR%\MiniMaxAssetTool.exe" echo RESULT-NEW-CONTENT=present
if exist "%INSTALL_DIR%\old_file.txt" (echo RESULT-OLD-CONTENT=leaked) else (echo RESULT-OLD-CONTENT=gone)
if defined OLD_DIR if exist "%OLD_DIR%" rmdir /s /q "%OLD_DIR%" >nul 2>&1

rem ---- 3. rollback path: swap fails -> old install restored ----
mkdir "%ROOT%\install_dir2"
echo keepme > "%ROOT%\install_dir2\precious.txt"
set "INSTALL_DIR=%ROOT%\install_dir2"
set "OLD_DIR=%INSTALL_DIR%.old-%RANDOM%"
move /y "%INSTALL_DIR%" "%OLD_DIR%" >nul 2>&1
rem staging missing on purpose -> swap fails -> rollback
move /y "%ROOT%\no_such_staging" "%INSTALL_DIR%" >nul 2>&1
if not exist "%INSTALL_DIR%\MiniMaxAssetTool.exe" (
  if defined OLD_DIR if exist "%OLD_DIR%" move /y "%OLD_DIR%" "%INSTALL_DIR%" >nul 2>&1
)
if exist "%INSTALL_DIR%\precious.txt" (echo RESULT-ROLLBACK=restored) else (echo RESULT-ROLLBACK=lost)

:done
rmdir /s /q "%ROOT%" 2>nul
endlocal
