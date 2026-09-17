@echo off
setlocal
cd /d "%~dp0"
bun web/server.ts
