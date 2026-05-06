@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\one-click-run.ps1" -Pause
if errorlevel 1 (
  echo.
  pause
)
endlocal
