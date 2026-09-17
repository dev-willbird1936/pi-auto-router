@echo off
setlocal
cd /d "%~dp0"
pi -e "%~dp0src\extension.ts" %*
