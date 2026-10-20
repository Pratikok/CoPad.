@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ngrok.ps1"
if errorlevel 1 (
  echo.
  echo CoPad could not start. Read the message above, then press any key to close.
  pause >nul
)
