@echo off
REM Double-click to install AE MCP and connect your AI apps.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\run.ps1" install %*
echo.
pause
