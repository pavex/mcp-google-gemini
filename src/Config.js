// Config.js — central configuration for mcp-google-gemini v2.0

const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;

export const Config = {
  API_KEY,

  validate() {
    if (!this.API_KEY) {
      process.stderr.write('[gemini-bridge] ERROR: API key not provided. Set GEMINI_API_KEY or pass as CLI argument.\n');
      process.exit(1);
    }

    if (process.argv[2]) {
      process.stderr.write('[gemini-bridge] WARNING: API key passed via CLI argument — visible in process list. Prefer GEMINI_API_KEY env var.\n');
    }
  },

  BASE_URL:         'https://generativelanguage.googleapis.com/v1beta/',
  FETCH_TIMEOUT_MS: Number(process.env.GEMINI_FETCH_TIMEOUT_MS) || 30_000,

  // ModelCache TTL
  TTL_OK_MS:        Number(process.env.GEMINI_TTL_OK_MS) || 300_000,  // 5 min

  // Context size limits — enforced in composePrompt before API call
  MAX_CONTEXT_BLOCK_CHARS: Number(process.env.GEMINI_MAX_CONTEXT_BLOCK_CHARS) || 100_000,
  MAX_PROMPT_CHARS:        Number(process.env.GEMINI_MAX_PROMPT_CHARS)        || 200_000,

  // Discovery: model IDs matching this regex are excluded as candidates for
  // ask_gemini even if the API reports generateContent support — catches
  // specialized non-chat product lines (image/tts/robotics/computer-use/...)
  // that share the "gemini-" naming prefix but aren't meant for text prompts.
  MODEL_EXCLUDE_REGEX: new RegExp(
    process.env.GEMINI_MODEL_EXCLUDE_REGEX || 'image|tts|computer-use|robotics',
    'i'
  ),

  MCP_SERVER_NAME:    'gemini-bridge',
  MCP_SERVER_VERSION: '2.0.0',
};

