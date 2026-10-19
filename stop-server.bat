@echo off
rem Stops the RiSriGPT server listening on port 3000.
rem If a listener can't be killed (Access is denied), re-runs itself elevated.

set "NEED_ADMIN="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000  *[0-9].*LISTENING"') do (
  echo Stopping PID %%p
  taskkill /f /t /pid %%p >nul 2>&1
  if errorlevel 1 set "NEED_ADMIN=1"
)

if not defined NEED_ADMIN goto :done

echo Could not stop the server ^(access denied^). Requesting administrator rights...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"

:done