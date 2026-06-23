@echo off
cd /d "%~dp0"
echo Starting Itera AI live server...
echo.
echo Dashboard: http://127.0.0.1:8787/index.html
echo Demo site:  http://127.0.0.1:8787/demo-target.html
echo Env files:  .env, .env.local, .env.production are loaded by server.js
echo.
set STORAGE_DRIVER=sqlite
set SQLITE_FILE=%~dp0data\itera.sqlite
npm.cmd start
