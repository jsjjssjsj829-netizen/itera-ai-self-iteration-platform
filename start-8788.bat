@echo off
cd /d "%~dp0"
set PORT=8788
set STORAGE_DRIVER=sqlite
set SQLITE_FILE=%~dp0data\itera.sqlite
echo Starting Itera AI live server on 8788...
echo.
echo Dashboard: http://127.0.0.1:8788/index.html
echo Demo site:  http://127.0.0.1:8788/demo-target.html
echo Env files:  .env, .env.local, .env.production are loaded by server.js
echo.
node server.js
