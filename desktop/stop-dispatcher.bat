@echo off
rem stop-dispatcher.bat - stop the dispatcher server together with the checks and agents it started (module win-desktop).
rem Port: DASH_PORT from the environment, otherwise 4777. Running work is cut off, not waited for.
setlocal
title Dispatcher - STOP
if not defined DASH_PORT set DASH_PORT=4777
set "SYS=%SystemRoot%\System32"

set "SRV="
rem No quotes around the programs here: for /f runs the line through cmd /c, which would strip the outer pair.
for /f "tokens=5" %%p in ('%SYS%\netstat.exe -ano ^| %SYS%\findstr.exe /R /C:":%DASH_PORT% .*LISTENING"') do set "SRV=%%p"

if not defined SRV (
  echo Dispatcher is not running on port %DASH_PORT%.
  "%SYS%\timeout.exe" /t 3 /nobreak >nul
  exit /b 0
)

echo Stopping server (pid %SRV%) with the checks and agents it started...
"%SYS%\taskkill.exe" /PID %SRV% /T /F >nul 2>&1
"%SYS%\timeout.exe" /t 2 /nobreak >nul

"%SYS%\netstat.exe" -ano | "%SYS%\findstr.exe" /R /C:":%DASH_PORT% .*LISTENING" >nul
if %errorlevel%==0 (
  echo FAILED to stop. Close the node process manually.
  pause
  exit /b 1
)
echo Stopped. Memory of agents and checks is released.
"%SYS%\timeout.exe" /t 3 /nobreak >nul
exit /b 0
