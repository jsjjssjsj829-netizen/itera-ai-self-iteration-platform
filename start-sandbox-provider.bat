@echo off
cd /d "%~dp0"
if "%SANDBOX_PROVIDER_PORT%"=="" set SANDBOX_PROVIDER_PORT=8794
if "%SANDBOX_PROVIDER_HOST%"=="" set SANDBOX_PROVIDER_HOST=127.0.0.1
if "%SANDBOX_PROVIDER_TOKEN%"=="" set SANDBOX_PROVIDER_TOKEN=itera-local-sandbox-token
if "%SANDBOX_PROVIDER_RUNTIME%"=="" set SANDBOX_PROVIDER_RUNTIME=local-process
echo Starting Itera sandbox provider...
echo.
echo Health: http://127.0.0.1:%SANDBOX_PROVIDER_PORT%/health
echo Run URL: http://127.0.0.1:%SANDBOX_PROVIDER_PORT%/run
echo.
npm.cmd run sandbox:provider
