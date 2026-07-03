@echo off
setlocal

if not "%~1"=="" (
  set GEMINI_API_KEY=%~1
) else if "%GEMINI_API_KEY%"=="" (
  echo Usage: build.cmd ^<GEMINI_API_KEY^>
  echo   or set GEMINI_API_KEY before running build.cmd
  echo ERROR: No API key provided.
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm install --no-audit --no-fund

echo [2/4] Building dist/mcp.js...
call npm run build
if %errorlevel% neq 0 (
  echo ERROR: Build failed.
  exit /b %errorlevel%
)

echo [3/4] Running tests...
call npm test
if %errorlevel% neq 0 (
  echo ERROR: Tests failed.
  exit /b %errorlevel%
)

echo [4/4] Cleaning up root node_modules...
if exist node_modules rd /s /q node_modules
if exist package-lock.json del /f /q package-lock.json

echo.
echo Done! dist/ is self-contained:
echo   dist/mcp.js  - bundled server
echo   Note: model list is embedded in code. Set GEMINI_MODELS_PATH for custom models.
endlocal
