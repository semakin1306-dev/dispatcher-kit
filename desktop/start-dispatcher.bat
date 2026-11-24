@echo off
rem start-dispatcher.bat - start the dispatcher server hidden and open its page as an app window (module win-desktop).
rem All paths are relative to this script: the dispatcher folder is one level up.
rem Port: DASH_PORT from the environment, otherwise 4777. Logs and the browser profile: %LOCALAPPDATA%\dispatcher-kit.
setlocal
title Dispatcher - START
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
if not defined DASH_PORT set DASH_PORT=4777
set "SYS=%SystemRoot%\System32"
set "PS=%SYS%\WindowsPowerShell\v1.0\powershell.exe"
set "URL=http://127.0.0.1:%DASH_PORT%/"
set "STATE=%LOCALAPPDATA%\dispatcher-kit"
rem Separate browser profile for the dashboard only: no history UI, no extensions, no sync, no tabs.
set "PROFILE=%STATE%\browser"
if not exist "%STATE%" mkdir "%STATE%"

"%SYS%\netstat.exe" -ano | "%SYS%\findstr.exe" /R /C:":%DASH_PORT% .*LISTENING" >nul
if %errorlevel%==0 (
  echo Dispatcher is already running on port %DASH_PORT%.
  goto window
)

if not exist "%ROOT%\scripts\dev\dashboard\server.mjs" (
  echo NOT FOUND: %ROOT%\scripts\dev\dashboard\server.mjs
  pause
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not in PATH. Install Node 22 or newer.
  pause
  exit /b 1
)

echo Starting server...
"%PS%" -NoProfile -Command "Start-Process node -ArgumentList '\"%ROOT%\scripts\dev\dashboard\server.mjs\"' -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%STATE%\server.log' -RedirectStandardError '%STATE%\server.err.log'"

echo Waiting for the server...
for /L %%i in (1,1,30) do (
  "%SYS%\netstat.exe" -ano | "%SYS%\findstr.exe" /R /C:":%DASH_PORT% .*LISTENING" >nul && goto ready
  "%SYS%\timeout.exe" /t 1 /nobreak >nul
)
echo Server did not start in 30 seconds. See %STATE%\server.err.log
pause
exit /b 1

:ready
echo Server started.

:window
rem If the dashboard window is already open, do not open a second one.
"%PS%" -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|msedge' -and $_.CommandLine -like '*--app=%URL%*' }) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo Dashboard window is already open.
  exit /b 0
)

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo Chrome/Edge not found, opening in the default browser.
  start "" "%URL%"
  exit /b 0
)

echo Opening the dashboard window...
rem Closing the window does not stop the server: use stop-dispatcher.bat.
start "" "%BROWSER%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=1700,1000 --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-translate --disable-background-mode --disable-background-networking --disable-component-update --disable-breakpad --disable-features=Translate,MediaRouter,OptimizationHints,msEdgeStartupBoost --disk-cache-size=52428800
exit /b 0
