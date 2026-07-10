@echo off
setlocal

if not "%~1"=="" set GEMINI_API_KEY=%~1

set HAS_KEY=0
if not "%GEMINI_API_KEY%"=="" set HAS_KEY=1
if "%HAS_KEY%"=="0" echo WARNING: GEMINI_API_KEY not set - integration tests will be skipped.

echo [1/4] Installing dependencies...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
  echo ERROR: npm install failed.
  exit /b %errorlevel%
)

echo [2/4] Building dist/mcp.js...
call npm run build
if %errorlevel% neq 0 (
  echo ERROR: Build failed.
  exit /b %errorlevel%
)

echo [3/4] Running tests...
call node test/unit.js
if %errorlevel% neq 0 (
  echo ERROR: Unit tests failed.
  exit /b %errorlevel%
)

if "%HAS_KEY%"=="1" (
  call node test/integration.js src
  if %errorlevel% neq 0 (
    echo ERROR: Integration tests ^(src^) failed.
    exit /b %errorlevel%
  )
  call node test/integration.js dist
  if %errorlevel% neq 0 (
    echo ERROR: Integration tests ^(dist^) failed.
    exit /b %errorlevel%
  )
) else (
  echo WARNING: Skipped integration tests - no GEMINI_API_KEY. Only unit tests ran.
)

echo [4/4] Cleaning up root node_modules...
if exist node_modules rd /s /q node_modules
if exist package-lock.json del /f /q package-lock.json

echo.
echo Done! dist/ is self-contained:
echo   dist/mcp.js  - bundled server
if "%HAS_KEY%"=="0" echo   NOTE: built WITHOUT integration test coverage ^(no API key at build time^).
echo   Note: model list is embedded in code. Set GEMINI_MODELS_PATH for custom models.
endlocal
