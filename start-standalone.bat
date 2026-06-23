@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18 LTS or newer from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8787
if "%NODE_ENV%"=="" set NODE_ENV=production
if "%STORAGE_DRIVER%"=="" set STORAGE_DRIVER=sqlite
if "%SQLITE_FILE%"=="" set SQLITE_FILE=%~dp0data\itera.sqlite
if "%ITERA_ALLOWED_REPO_ROOT%"=="" set ITERA_ALLOWED_REPO_ROOT=%~dp0..

echo.
echo Itera AI standalone server
echo --------------------------
echo Dashboard: http://%HOST%:%PORT%/
echo Docs:      http://%HOST%:%PORT%/docs
echo Health:    http://%HOST%:%PORT%/api/health
echo Data:      %SQLITE_FILE%
echo.

node scripts\standalone-check.js
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo Starting server. Keep this window open while using Itera AI.
echo Press Ctrl+C to stop.
echo.
node server.js
pause
