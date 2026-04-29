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

echo "[1/5] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/5] Building dist/mcp.js..."
npm run build

echo "[3/5] Copying models.json to dist/..."
mkdir -p dist
cp models.json dist/models.json

echo "[4/5] Running tests..."
npm test

echo "[5/5] Cleaning up root node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done! dist/ is self-contained:"
echo "  dist/mcp.js      - bundled server"
echo "  dist/models.json - model tier configuration (edit to customize)"
