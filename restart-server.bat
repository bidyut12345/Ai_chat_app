@echo off
rem ============================================================
rem  RiSriGPT - restart the server
rem  Stops any server already listening on the port, then starts it.
rem  Runs elevated (once) so it can kill an elevated server process.
rem ============================================================
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=3000"

rem ---------- self elevate (once) ----------
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem ---------- stop any existing listener ----------
set "NEED_ADMIN="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT%  *[0-9].*LISTENING"') do (
  echo Stopping existing server PID %%p
  taskkill /f /t /pid %%p >nul 2>&1
  if errorlevel 1 set "NEED_ADMIN=1"
)
if defined NEED_ADMIN (
  echo Could not stop the server ^(access denied^).
  exit /b 1
)

rem Give the OS a moment to release the port.
ping -n 3 127.0.0.1 >nul

rem ---------- start ----------
if not exist logs mkdir logs
if not exist data mkdir data

echo Starting RiSriGPT on 0.0.0.0:%PORT%, logging to logs\server.log ...
cscript //nologo "%~dp0start-server-hidden.vbs" %PORT%

ping -n 6 127.0.0.1 >nul
netstat -ano | findstr /r /c:":%PORT%  *[0-9].*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Server did not start. Check logs\server.log
  exit /b 1
)
echo RiSriGPT restarted and listening on port %PORT%.
