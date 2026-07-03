#!/usr/bin/env bash
set -euo pipefail

if [ -n "${1:-}" ]; then
  export GEMINI_API_KEY="$1"
elif [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Usage: ./build.sh <GEMINI_API_KEY>"
  echo "  or set GEMINI_API_KEY before running build.sh"
  echo "ERROR: No API key provided."
  exit 1
fi

echo "[1/4] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/4] Building dist/mcp.js..."
npm run build

echo "[3/4] Running tests..."
npm test

echo "[4/4] Cleaning up root node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done! dist/ is self-contained:"
echo "  dist/mcp.js  - bundled server"
echo "  Note: model list is embedded in code. Set GEMINI_MODELS_PATH for custom models."
