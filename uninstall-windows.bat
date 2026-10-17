@echo off
REM Double-click to uninstall AE MCP on Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required but was not found.
  echo Install the LTS version from https://nodejs.org and run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node "%~dp0installer\uninstall.mjs" %*
pause
