@echo off
REM Double-click to install AE MCP and connect your AI apps.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\run.ps1" install %*
echo.
pause
