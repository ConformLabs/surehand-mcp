@echo off
REM Double-click to check that AE MCP is installed and can talk to After Effects.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\run.ps1" selftest %*
echo.
pause
