@echo off
rem ============================================================
rem  Local AI Chat - start the server on ALL interfaces (LAN), as administrator
rem  Safe to run twice: does nothing if the port is already up.
rem ============================================================
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=3000"

rem ---------- self elevate ----------
rem If not already admin, relaunch this script elevated (one UAC prompt) and stop.
rem When started by the boot scheduled task (RunLevel Highest) this is a no-op.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netstat -ano | findstr /r /c:":%PORT%  *[0-9].*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Local AI Chat is already running on port %PORT%.
  exit /b 0
)

if not exist logs mkdir logs
if not exist data mkdir data

echo Starting Local AI Chat on 0.0.0.0:%PORT%, logging to logs\server.log ...
rem Hidden launcher (no console window at all). Output: logs\server.log.
cscript //nologo "%~dp0start-server-hidden.vbs" %PORT%

ping -n 6 127.0.0.1 >nul
netstat -ano | findstr /r /c:":%PORT%  *[0-9].*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Server did not start. Check logs\server.log
  exit /b 1
)
echo Server is up on port %PORT%.