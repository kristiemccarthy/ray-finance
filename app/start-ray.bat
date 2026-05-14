@echo off
setlocal

REM =====================================================================
REM start-ray.bat — auto-start the Ray production web app on Windows login.
REM
REM What this does
REM ----------------
REM   1. cd into the Next.js app directory (full path — Task Scheduler
REM      doesn't preserve a working directory).
REM   2. Runs `npm run start` (which runs `next start -p 3000`).
REM   3. Appends stdout + stderr to app\ray-server.log in the same dir.
REM   4. Runs hidden — no persistent console window.
REM
REM How to use it
REM -------------
REM   Double-click in Explorer:
REM       Brief cmd flash, then runs hidden in the background.
REM
REM   Task Scheduler (recommended for auto-start at login):
REM       Create a Basic Task → trigger "When I log on" → action
REM       "Start a program" → program/script = full path to this file.
REM       In the task's General tab, also tick "Hidden" for belt and
REM       braces — the self-relaunch below already hides the window, but
REM       Hidden suppresses the brief flash on slower machines.
REM
REM How to stop the server
REM ----------------------
REM   The server runs as a node.exe on port 3000. To kill it cleanly:
REM
REM       powershell -Command "Get-NetTCPConnection -LocalPort 3000 ^
REM           | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
REM
REM   Or open Task Manager, sort by command line, kill the node.exe
REM   under the npm/next process tree.
REM
REM Why the self-relaunch dance
REM ---------------------------
REM   A pure batch file can't hide its own cmd window. Trick: relaunch
REM   ourselves through PowerShell's -WindowStyle Hidden, passing a
REM   marker arg so we know the second invocation is the hidden one.
REM   The first invocation exits immediately; the hidden copy does the
REM   real work. Brief cmd flash possible on double-click, none under
REM   Task Scheduler with Hidden ticked.
REM
REM Log file
REM --------
REM   Each launch appends a "=== <date> <time> Ray server starting ==="
REM   marker so restart boundaries are easy to spot. Truncate or rotate
REM   manually if the file gets large — there's no built-in rotation.
REM =====================================================================

REM --- Self-relaunch hidden if we weren't already invoked that way ---
if /i not "%~1"=="--hidden" (
    powershell -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '--hidden' -WindowStyle Hidden"
    exit /b 0
)

REM --- Hidden-mode body below ---

set "APP_DIR=C:\Users\krist\Documents\GitHub\ray-finance\app"
set "LOG=%APP_DIR%\ray-server.log"

cd /d "%APP_DIR%"

REM Session marker — `>> ... echo` rather than `echo ... >>` so the
REM redirection target stays at the start of each line for grep.
>> "%LOG%" echo.
>> "%LOG%" echo === %DATE% %TIME% Ray server starting ===

REM `call` is required for npm.cmd so control returns to this script
REM after the npm process finishes (otherwise the exit-code echo and
REM endlocal below would never run).
call npm run start >> "%LOG%" 2>&1

>> "%LOG%" echo === %DATE% %TIME% Ray server exited (code %ERRORLEVEL%) ===

endlocal
exit /b %ERRORLEVEL%
