# Google Gemini — Smart Model Fallback for Claude Desktop

A lightweight MCP (Model Context Protocol) server that connects **Claude Desktop** to the **Google Gemini API**. Automatically selects the best available Gemini model using a tier-based fallback strategy with intelligent quota tracking — so your AI tools keep working even when individual models hit rate limits.

Built on `@modelcontextprotocol/sdk` with zero Gemini-specific dependencies (uses Node.js built-in `fetch`).

---

## Features

- **3 MCP tools** — `ask_gemini`, `list_models`, `gemini_status`
- **Smart model cache** — tracks quota (RPM/RPD), availability, and TTL per model in memory
- **Quota-aware fallback** — reads `Retry-After` header and quota type (per-minute vs per-day), skips blocked models automatically
- **Structured prompts** — optional `context[]` blocks (`skill` / `data` / `text`) prepended before the prompt (with size limit validation)
- **Tier-based selection** — models ranked by tier; best available tier selected automatically on every call
- **Custom model overrides** — embedded default model list works out of the box, but can be overridden via config file
- **Zero Gemini deps** — uses built-in Node.js `fetch` (Node 18+)

---

## Requirements

- Node.js 18+
- Google Gemini API key — [Get one at Google AI Studio](https://aistudio.google.com/app/apikey)

---

## Build

The build script installs dependencies, compiles the bundle, runs the full test suite, and cleans up `node_modules` (in production/release runs).

**Windows:**
```cmd
build.cmd YOUR_GEMINI_API_KEY
```

**Linux / macOS:**
```bash
chmod +x build.sh
./build.sh YOUR_GEMINI_API_KEY
```

If `GEMINI_API_KEY` is already set in your environment, you can omit the argument:
```cmd
build.cmd
```
```bash
./build.sh
```

After a successful build, `dist/` contains the self-contained bundle:
```
dist/
  mcp.js        — bundled server (single file, no node_modules needed)
```

---

## Claude Desktop Setup

Open the Claude Desktop configuration file:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following entry:

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["C:/absolute/path/to/dist/mcp.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. All three tools will be available in every conversation.

---

## Model Configuration

By default, the server uses a built-in model list ranked by `tier` (always attempting the lowest tier first):
1. `gemini-2.5-pro` (Tier 1) — Best reasoning, complex tasks
2. `gemini-2.5-flash` (Tier 2) — Fast, capable, balanced
3. `gemini-2.5-flash-lite` (Tier 3) — Lightweight, high quota
4. `gemini-2.0-flash` (Tier 4) — Fallback, stable

To override this default list with custom models or different tiers, create a JSON configuration file and set the `GEMINI_MODELS_PATH` environment variable pointing to its absolute path:

```json
[
  { "id": "gemini-2.5-pro",        "tier": 1, "desc": "best reasoning, complex tasks" },
  { "id": "gemini-2.5-flash",      "tier": 2, "desc": "fast, capable, balanced" }
]
```

---

## Tools

### `ask_gemini`

Sends a prompt to Gemini. Automatically selects the best available model by tier, or uses the model you specify.

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string (required) | The question or instruction (max 200,000 characters) |
| `model` | string (optional) | Override model ID, e.g. `"gemini-2.5-pro"` |
| `context` | array (optional) | Structured context blocks, max 5 (max 100,000 characters per block) |

**context block:**
```json
{ "type": "skill|data|text", "text": "..." }
```
- `skill` blocks are sent natively as `systemInstruction` in the API payload.
- `data` and `text` blocks are concatenated prepended to the user prompt.

Composed prompt format when context is provided:
```
[data]
{ "version": "2.0" }

[prompt]
Review this code for bugs.
```

**Response — always a JSON string in `content[0].text`:**
```json
{ "ok": true,  "text": "...", "model_used": "gemini-2.5-pro" }
{ "ok": false, "error": "quota",   "retry": false, "best_retry_in": "43s" }
{ "ok": false, "error": "blocked", "retry": false, "reason": "..." }
{ "ok": false, "error": "timeout", "retry": true }
```

Always check `ok` before using `text`.

---

### `list_models`

Returns the model list with current cache status. **No API calls made.**

```json
[
  { "id": "gemini-2.5-pro",        "tier": 1, "status": "ok",        "retry_in": null },
  { "id": "gemini-2.5-flash",      "tier": 2, "status": "quota_rpm", "retry_in": "43s" },
  { "id": "gemini-2.5-flash-lite", "tier": 3, "status": "unknown",   "retry_in": null }
]
```

**Status values:** `ok` | `quota_rpm` | `quota_rpd` | `error` | `unknown`

Use this to decide which model to pass to `ask_gemini`.

---

### `gemini_status`

Actively probes first N models and warms up the cache. Stops at the first successful model.

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer (optional) | Number of models to probe, default 3 |

Use for debugging or cache warmup. For a quick overview without API calls, use `list_models` instead.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | API key (required) |
| `GEMINI_FETCH_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds |
| `GEMINI_TTL_OK_MS` | `300000` | Cache TTL for healthy models (default 5 min) |
| `GEMINI_MAX_PROMPT_CHARS` | `200000` | Max characters allowed in `prompt` parameter |
| `GEMINI_MAX_CONTEXT_BLOCK_CHARS` | `100000` | Max characters allowed in a single context block |
| `GEMINI_MODELS_PATH` | — | Optional custom path to models JSON file (replaces built-in list) |

---

## Project Structure

```
src/
  mcp.js              — entry point (Server + StdioTransport)
  Config.js           — API key, timeouts, TTL, models path
  GeminiClient.js     — callGemini(), probeModel(), parse429()
  ModelCache.js       — in-memory cache per model
  Tools/
    AskGemini.js
    ListModels.js
    GeminiStatus.js
  Utils/
    composePrompt.js
dist/
  mcp.js              — bundled output (esbuild, single file)
  models.json         — model tier configuration (source of truth)
test/
  unit.js             — unit tests (ModelCache, composePrompt), no API calls
  integration.js      — integration tests via stdio JSON-RPC
```

---

## Running Tests

```bash
# Unit tests only (no API key needed)
node test/unit.js

# Integration tests against src/ (requires GEMINI_API_KEY)
node test/integration.js src

# Integration tests against dist/
node test/integration.js dist

# Full suite (same as npm test)
npm test
```

---

## License

MIT
