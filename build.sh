#!/usr/bin/env bash
set -euo pipefail

HAS_KEY=false
if [ -n "${1:-}" ]; then
  export GEMINI_API_KEY="$1"
  HAS_KEY=true
elif [ -n "${GEMINI_API_KEY:-}" ]; then
  HAS_KEY=true
else
  echo "WARNING: GEMINI_API_KEY not set - integration tests will be skipped."
fi

echo "[1/4] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/4] Building dist/mcp.js..."
npm run build

echo "[3/4] Running tests..."
if ! node test/unit.js; then
  echo "ERROR: Unit tests failed."
  exit 1
fi

if [ "$HAS_KEY" = true ]; then
  if ! node test/integration.js src; then
    echo "ERROR: Integration tests (src) failed."
    exit 1
  fi
  if ! node test/integration.js dist; then
    echo "ERROR: Integration tests (dist) failed."
    exit 1
  fi
else
  echo "WARNING: Skipped integration tests - no GEMINI_API_KEY. Only unit tests ran."
fi

echo "[4/4] Cleaning up root node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done! dist/ is self-contained:"
echo "  dist/mcp.js  - bundled server"
if [ "$HAS_KEY" = false ]; then
  echo "  NOTE: built WITHOUT integration test coverage (no API key at build time)."
fi
echo "  Note: model list is embedded in code. Set GEMINI_MODELS_PATH for custom models."
