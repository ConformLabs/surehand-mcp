@echo off
REM Double-click to remove Surehand MCP.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\run.ps1" uninstall %*
echo.
pause
