@echo off
REM Double-click to remove AE MCP.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\run.ps1" uninstall %*
echo.
pause
