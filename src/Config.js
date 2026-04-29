// Config.js — central configuration for mcp-google-gemini v2.0

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;

if (!API_KEY) {
  process.stderr.write('[gemini-bridge] ERROR: API key not provided. Set GEMINI_API_KEY or pass as CLI argument.\n');
  process.exit(1);
}

if (process.argv[2]) {
  process.stderr.write('[gemini-bridge] WARNING: API key passed via CLI argument — visible in process list. Prefer GEMINI_API_KEY env var.\n');
}

export const Config = {
  API_KEY,

  BASE_URL:         'https://generativelanguage.googleapis.com/v1beta/',
  FETCH_TIMEOUT_MS: Number(process.env.GEMINI_FETCH_TIMEOUT_MS) || 30_000,

  // ModelCache TTL
  TTL_OK_MS:        Number(process.env.GEMINI_TTL_OK_MS) || 300_000,  // 5 min

  // Path to models.json — defaults to models.json next to the running script (dist/models.json).
  // Override with GEMINI_MODELS_PATH env var if needed.
  MODELS_PATH:      process.env.GEMINI_MODELS_PATH ?? join(__dirname, 'models.json'),

  MCP_SERVER_NAME:    'gemini-bridge',
  MCP_SERVER_VERSION: '2.0.0',
};
