@echo off
setlocal

if "%~1"=="" (
  echo Usage: build.cmd ^<GEMINI_API_KEY^>
  echo   or set GEMINI_API_KEY before running build.cmd
  if "%GEMINI_API_KEY%"=="" (
    echo ERROR: No API key provided.
    exit /b 1
  )
) else (
  set GEMINI_API_KEY=%~1
)

echo [1/5] Installing dependencies...
call npm install --no-audit --no-fund

echo [2/5] Building dist/mcp.js...
call npm run build

echo [3/5] Copying models.json to dist/...
if not exist dist mkdir dist
copy /y models.json dist\models.json >nul

echo [4/5] Running tests...
call npm test

echo [5/5] Cleaning up root node_modules...
if exist node_modules rd /s /q node_modules
if exist package-lock.json del /f /q package-lock.json

echo.
echo Done! dist/ is self-contained:
echo   dist/mcp.js      - bundled server
echo   dist/models.json - model tier configuration (edit to customize)
endlocal
