@echo off
rem ============================================================
rem  Everything, in order:
rem    1. Strata model server  (C:\AI\Strata, port 8080)
rem    2. wait until its API answers (the weights take minutes)
rem    3. Local AI Chat        (port 3000, open on the LAN)
rem  This is what the boot task runs.
rem ============================================================
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs

rem Give Windows a moment: at boot the network adapter may still be settling, and
rem a boot-triggered scheduled task has no random-delay of its own.
ping -n 21 127.0.0.1 >nul

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