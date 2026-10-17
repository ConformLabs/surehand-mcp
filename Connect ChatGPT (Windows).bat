@echo off
REM Double-click to connect ChatGPT (starts a local server and a secure tunnel; keep the window open).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\run.ps1" chatgpt %*
echo.
pause
