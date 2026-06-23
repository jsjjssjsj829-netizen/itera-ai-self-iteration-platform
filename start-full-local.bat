@echo off
cd /d "%~dp0"
if "%SANDBOX_PROVIDER_PORT%"=="" set SANDBOX_PROVIDER_PORT=8794
if "%SANDBOX_PROVIDER_HOST%"=="" set SANDBOX_PROVIDER_HOST=127.0.0.1
if "%SANDBOX_PROVIDER_TOKEN%"=="" set SANDBOX_PROVIDER_TOKEN=itera-local-sandbox-token
if "%SANDBOX_PROVIDER_RUNTIME%"=="" set SANDBOX_PROVIDER_RUNTIME=local-process
set SANDBOX_PROVIDER_URL=http://127.0.0.1:%SANDBOX_PROVIDER_PORT%/run
set SANDBOX_PROVIDER_PRIVATE_NETWORK=false
set STORAGE_DRIVER=sqlite
set SQLITE_FILE=%~dp0data\itera.sqlite
set ITERA_ALLOWED_REPO_ROOT=%~dp0..

echo Starting Itera AI with local isolated sandbox provider...
echo.
echo Dashboard:        http://127.0.0.1:8787/index.html
echo Sandbox health:   http://127.0.0.1:%SANDBOX_PROVIDER_PORT%/health
echo Sandbox run URL:  %SANDBOX_PROVIDER_URL%
echo.
start "Itera Sandbox Provider" cmd /k call "%~dp0start-sandbox-provider.bat"
timeout /t 2 /nobreak >nul
npm.cmd start
