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

The build script installs dependencies, compiles the bundle, runs the test suite, and cleans up `node_modules` (in production/release runs).

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

Prefer setting the env var over the CLI argument when possible — an argument can end up in shell history and process listings.

**The API key is optional at build time.** Unit tests (no API calls) always run. If no key is provided (CLI arg or env var), the build prints a warning and skips the integration tests (which spawn a real server and need a live key) instead of failing — useful for CI or packaging without exposing a key. The build only fails on an actual build/test failure, never merely on a missing key.

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

**Empty by default — no hardcoded fallback list.** `.storage/models.json` starts empty/absent. If `ask_gemini` is called before any models are known, it returns a clear `{ ok: false, error: "no_models", ... }` telling the calling agent to run `list_models` with `refresh: true`. There is no built-in list of hardcoded model IDs served silently as a fallback — that used to mask real discovery failures behind stale, plausible-looking data.

**Boot behavior:** on every start (with an API key present), the server makes one cheap `ListModels` call (metadata only, no `generateContent`, so no token cost) and hashes the resulting catalog (after excluding non-chat product lines — see below). That hash is compared to the one stored in `.storage/models.json`:
- **Unchanged** → nothing else happens, boot is fast, the server uses whatever was already persisted (possibly still empty).
- **Changed, or no persisted baseline yet** → a full refresh (see below) is kicked off **in the background**. The server becomes ready immediately either way; the model list updates live once the refresh completes (typically a few seconds).
- If the cheap check itself fails (network hiccup), it fails open — boot proceeds with whatever was already persisted, and it's retried on the next start.

**Full refresh** (background-triggered on catalog change, or on-demand via `list_models({ refresh: true })`):
1. Live `ListModels` discovery (paginated).
2. Cheap keyword pre-filter — excludes non-`gemini-` model families (`gemma-*`, `lyria-*`, ...) and known non-chat product lines matching `GEMINI_MODEL_EXCLUDE_REGEX` (default: `image|tts|computer-use|robotics`) — catches things like `gemini-3-pro-image`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-computer-use-preview-...` that technically report `generateContent` support but aren't meant for plain text prompts.
3. **Real probe call** per surviving candidate (a short live `generateContent` request) — confirms it actually behaves like a text-chat model rather than just trusting the ID string. A candidate is only dropped if it comes back with a structural rejection (`error` status); quota/timeout/network failures during the probe don't disqualify a model, since those are about availability, not type.
4. Ranks survivors into tiers (version number, `pro` > `flash` > `flash-lite`, small tie-break nudge against `-exp`/`-preview` tags — not a hard demotion, since some current-generation flagships are only available under a `-preview` id) and persists to `.storage/models.json`.

This is the expensive path (one `ListModels` call + one real `generateContent` call per candidate — real quota cost), so it's never run automatically on every boot, only when the catalog actually changed or on explicit request.

`.storage/models.json` also tracks live quota/availability status per model, updated after every real `ask_gemini`/`gemini_status` call, so the cache survives restarts without needing a refresh.

**Fallback order at call time** is not just the stored `tier` — it's adjusted at runtime by two signals, so you don't need to trigger a refresh to change behavior:
- `GEMINI_MODEL_DEPRIORITIZE_REGEX` — a model matching this pattern is always tried last (e.g. set to `"pro"` if your key's `pro` quota is chronically exhausted).
- **Adaptive daily fail ratio** — each model's today's (UTC) success/failure counts are tracked automatically; a model that's been failing a lot today is nudged toward the back of the fallback queue. Resets every UTC day, so a bad morning doesn't permanently penalize a model.

To bypass discovery entirely and pin a fully custom model list, set `GEMINI_MODELS_PATH` to an absolute path of your own JSON file — this disables auto-discovery and persistence, giving you full manual control:

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
| `model` | string (optional) | Escape hatch only — pins exact model, no fallback. Default: omit. |
| `context` | array (optional) | Structured context blocks, max 5 (max 100,000 characters per block). Prefer a raw array of `{type, text}` objects — see tolerated shapes below. |

**context block:**
```json
{ "type": "skill|data|text", "text": "..." }
```
- `skill` blocks are sent natively as `systemInstruction` in the API payload.
- `data` and `text` blocks are concatenated prepended to the user prompt.

**Tolerated malformed shapes** — some LLM clients don't send exactly the shape above. The server normalizes these automatically instead of rejecting them:
- A JSON-stringified array (e.g. `"[{\"type\":\"data\",\"text\":\"...\"}]"`) is parsed automatically.
- A single bare object (e.g. `{"type":"data","text":"..."}` instead of wrapped in `[...]`) is auto-wrapped into a one-element array.
- A plain string inside the array (e.g. `["some note"]`) is treated as a `{type:"text", text:"some note"}` block.

These are fallbacks for robustness, not the recommended format — always prefer sending the raw `[{type,text}, ...]` array directly.

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
{ "ok": false, "error": "no_models", "retry": false, "reason": "..." }
```

Always check `ok` before using `text`.

**Handling failures (for the calling agent):**
- `retry: true` — wait `best_retry_in`, then retry, up to ~3 attempts total. If it's still failing, or `best_retry_in` is very long (minutes+), stop and tell the user Gemini is temporarily unavailable instead of looping.
- `error: "quota"`, `retry: false` — daily quota hit; don't retry until tomorrow UTC, inform the user.
- `error: "blocked"` — content blocked by safety filters; inform the user, retrying will not help.
- If you passed `model` and got `ok: false`, retry **without** `model` so the server can fall back to another model — unless you specifically need that exact one.
- `error: "no_models"` — no models known yet; call `list_models` with `refresh: true` (costs real API calls), then retry `ask_gemini`.

---

### `list_models`

Returns the model list with current cache status.

| Parameter | Type | Description |
|---|---|---|
| `refresh` | boolean (optional) | If `true`, re-discovers models from the live API, filters out non-chat product lines, test-probes each remaining candidate with a real short call, and persists the validated, ranked result. **Costs real API calls** — one to list models, plus one per candidate. Default: `false` (cache only, free). |

**Response:**
```json
{
  "refreshed": false,
  "refreshed_at": "2026-07-11T09:00:00.000Z",
  "stale": false,
  "models": [
    { "id": "gemini-2.5-pro",        "tier": 1, "desc": "auto-discovered", "status": "ok",        "retry_in": null },
    { "id": "gemini-2.5-flash",      "tier": 2, "desc": "auto-discovered", "status": "quota_rpm", "retry_in": "43s" }
  ]
}
```

`refreshed_at` is `null` and `stale` is `true` if no refresh has ever completed (e.g. right after `.storage/models.json` was deleted, before the background refresh finishes) or if it was last refreshed over 30 days ago — this is informational only; a refresh is never triggered automatically just because of staleness.

**Status values:** `ok` | `quota_rpm` | `quota_rpd` | `error` | `unknown`

If `models` is empty, or `ask_gemini` returned `error: "no_models"`, call this with `refresh: true`.

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
| `GEMINI_MODELS_PATH` | — | Optional custom path to models JSON file — disables auto-discovery/persistence |
| `GEMINI_MODEL_EXCLUDE_REGEX` | `image\|tts\|computer-use\|robotics` | Model IDs matching this regex are excluded from discovery as ask_gemini candidates, even if the API reports generateContent support — catches non-chat product lines sharing the `gemini-` prefix |
| `GEMINI_MODEL_DEPRIORITIZE_REGEX` | — | Models matching this regex (e.g. `"pro"`) are tried last during fallback, regardless of tier — useful on free-tier keys where `pro` models are chronically quota-limited |
| `GEMINI_MODEL_DEPRIORITIZE_PENALTY` | `1000` | How strongly the regex match is deprioritized (internal ranking score) |

---

## Project Structure

```
src/
  mcp.js                    — entry point (Server + StdioTransport)
  Config.js                 — API key, timeouts, TTL, models path, exclude regex
  GeminiClient.js            — orchestration: callGemini() (fallback loop, response shaping, no_models case)
  GeminiProbe.js             — probeModel(): tests one model with a short live call (no disk writes)
  GeminiAPI.js               — low-level request helpers (URL/body building, 429/response parsing)
  GeminiModelRegistry.js     — model bootstrap: cheap catalog hash-check on boot, full probe-validated refresh on change/on-demand, .storage/models.json persistence, manual override
  GeminiModelPrioritizer.js  — runtime fallback ordering (deprioritize regex, adaptive fail ratio)
  ModelCache.js              — in-memory cache per model
  Tools/
    AskGemini.js
    ListModels.js
    GeminiStatus.js
  Utils/
    composePrompt.js
dist/
  mcp.js              — bundled output (esbuild, single file)
.storage/
  models.json         — self-maintained: catalog_hash + refreshed_at + ranked models + live status (git-ignored)
test/
  unit.js             — unit tests (ModelCache, composePrompt, AskGemini schema), no API calls
  integration.js      — integration tests via stdio JSON-RPC (uses a fixed GEMINI_MODELS_PATH fixture, not live discovery)
  discovery-check.js  — standalone diagnostic: live catalog + category pre-filter, no probing, no persistence
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

# Diagnostic: check the live model catalog directly (real network call, no
# generateContent cost) — shows the raw catalog, the category pre-filter
# result, and prints the exact error if the call fails (useful since that
# error is otherwise only visible in the MCP server's own stderr, which is
# easy to miss). Does NOT probe/validate/persist — see list_models(refresh:true)
# for that.
node test/discovery-check.js YOUR_GEMINI_API_KEY
```

---

## License

MIT
