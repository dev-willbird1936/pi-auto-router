@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required.& exit /b 1)
where bun >nul 2>nul || (echo Bun is required for tests; Pi itself can still load the extension.)
npm install --ignore-scripts --no-audit --no-fund --package-lock=false
if errorlevel 1 exit /b %errorlevel%
echo Pi Auto Router is ready.
echo Install it into Pi with: pi install "%~dp0"
