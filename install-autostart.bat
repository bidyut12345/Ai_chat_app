@echo off
rem ============================================================
rem  One-click installer for RiSriGPT Windows Autostart
rem  Configures autostart at Windows logon for the current user
rem  with full interactive desktop access (screen & automation).
rem ============================================================
setlocal
cd /d "%~dp0"
echo Setting up RiSriGPT to run on Windows startup for %USERNAME%...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause

