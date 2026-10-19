@echo off
rem Stops the Local AI Chat server listening on port 3000.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000  *[0-9].*LISTENING"') do (
  echo Stopping PID %%p
  taskkill /f /pid %%p >nul
)