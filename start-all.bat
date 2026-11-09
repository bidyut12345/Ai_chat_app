@echo off
rem ============================================================
rem  Everything, in order:
rem    1. Model server (port 8080)
rem    2. Wait until its API answers
rem    3. RiSriGPT (port 3000, open on the LAN)
rem  Runs on Windows logon in the current user interactive session.
rem ============================================================
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs

rem Brief pause for network adapter and desktop session to initialize
ping -n 6 127.0.0.1 >nul

call start-model.bat
if errorlevel 1 goto :model_fail

echo Waiting for the model server on http://127.0.0.1:8080 ...
set "TRIED=0"
:wait
powershell -NoProfile -Command "try { Invoke-RestMethod 'http://127.0.0.1:8080/v1/models' -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :ready
set /a TRIED+=1
if %TRIED% GEQ 360 (
  echo Model server did not answer within 30 minutes. Starting the chat app anyway.
  goto :app
)
ping -n 6 127.0.0.1 >nul
goto :wait

:ready
echo Model server is ready.

:app
call start-server.bat
exit /b 0

:model_fail
echo The model server could not be started; see the message above.
exit /b 1
