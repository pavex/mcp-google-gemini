# Gemini Bridge – MCP Server for Claude Desktop

A lightweight, zero-dependency MCP server that connects **Claude Desktop** with the **Google Gemini API**. Pure Node.js implementation with automatic model fallback on quota errors. Includes a standalone CLI chat client for direct conversations with Gemini.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Model Configuration](#model-configuration-modelsjson)
- [Claude Desktop Setup](#claude-desktop-setup)
- [Usage](#usage)
- [CLI Chat – chat.js](#cli-chat--chatjs)
- [Environment Variables](#environment-variables)
- [Project Files](#project-files)

---

## Features

- **Single tool** – `ask_gemini(prompt)` available directly in Claude conversations
- **Automatic fallback** – switches to the next model in the chain on quota error (HTTP 429)
- **Zero dependencies** – uses only built-in Node.js modules (`fs`, `path`, `fetch`)
- **External model config** – fallback chain is managed via `models.json`, no code changes needed
- **CLI chat client** – interactive multi-turn chat with Gemini directly in the terminal
- **Low latency** – minimal overhead, fast startup

---

## Requirements

- Node.js 18+
- Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

---

## Installation

```bash
git clone https://github.com/your-repo/mcp-google-gemini.git
cd mcp-google-gemini
```

No `npm install` needed – the project has zero dependencies.

---

## Model Configuration (`models.json`)

The `models.json` file contains a plain array of Gemini model names used as the fallback chain – ordered from most powerful to lightest:

```json
[
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite"
]
```

The server tries models **left to right** and uses the first one that responds without error. If the file is missing or invalid, a built-in fallback list is used automatically.

Both `mcp.js` and `chat.js` share the same `models.json` — configure once, works everywhere.

### Updating the model list – `models.js`

The `models.js` script fetches all available models from the Gemini API, tests each one, and optionally writes the results to `models.json`.

#### List and test all models

```bash
node models.js [API_KEY]
```

Prints a table of all available models with their status:

```
Fetching model list...
Found 28 models.

Testing models...

MODEL                                    STATUS   DETAIL
--------------------------------------------------------------------------------
gemini-2.5-flash                         OK       gemini-2.5-flash
gemini-flash-latest                      OK       gemini-2.5-flash
gemini-2.5-pro                           OK       gemini-2.5-pro
gemini-3-flash-preview                   QUOTA    quota exceeded
gemini-2.0-flash                         ERROR    HTTP 403: ...
--------------------------------------------------------------------------------
Summary: OK: 7  QUOTA: 12  ERROR/NETWORK: 9
```

Status codes:
- `OK` – model is available and responding
- `QUOTA` – model exists but free tier quota is exhausted
- `ERROR` – model is not accessible (403, 400, etc.)
- `NETWORK` – network or connection error

#### Run setup (write results to `models.json`)

```bash
node models.js [API_KEY] --setup
```

Tests all models and writes the working ones to `models.json`:
- **OK models** first, sorted by context window size (largest first)
- **QUOTA models** appended after OK (available, just rate-limited)
- **ERROR/NETWORK models** are excluded

After running setup, **restart Claude Desktop** so the server picks up the updated model list.

---

## Claude Desktop Setup

### Option 1 – Configuration file (recommended)

Open the Claude Desktop configuration file:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the `mcpServers` section:

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["C:/path/to/mcp-google-gemini/mcp.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Option 2 – API key as CLI argument

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["C:/path/to/mcp-google-gemini/mcp.js", "your_api_key_here"]
    }
  }
}
```

Save the file and **restart Claude Desktop**. The `ask_gemini` tool will be available in every conversation.

---

## Usage

Once configured, the `ask_gemini` tool is available automatically. Claude can invoke it internally, or you can request it explicitly:

```
Ask Gemini: what are the main differences between React and Vue?
```

```
Use Gemini to research: what is the Model Context Protocol?
```

The server automatically uses the first working model from `models.json` and falls back to the next one on quota errors.

---

## CLI Chat – `chat.js`

A standalone interactive chat client for talking to Gemini directly in the terminal — no Claude Desktop required. Uses the same `models.json` configuration as `mcp.js`.

### Starting the chat

```bash
node chat.js [API_KEY]
```

The API key can also be provided via the `GEMINI_API_KEY` environment variable:

```bash
set GEMINI_API_KEY=your_api_key_here
node chat.js
```

### Example session

```
Gemini CLI Chat
Models: gemini-2.5-flash (+27 fallbacks)
Commands: /exit  /clear  /model
--------------------------------------------------
You: What is the capital of Japan?
Gemini: The capital of Japan is Tokyo.
[gemini-2.5-flash]

You: And what is its population?
Gemini: Tokyo has a population of approximately 13.96 million in the city proper,
        and around 37 million in the greater metropolitan area.
[gemini-2.5-flash]

You: /model
[Active model: gemini-2.5-flash]

You: /clear
[History cleared]

You: /exit
Bye!
```

### How context works

`chat.js` maintains a full **conversation history** for the entire session. Every message you send includes the complete history of the conversation, so Gemini can reference and build on everything said earlier — just like a natural chat.

Internally, the history is a growing array of alternating `user` and `model` turns sent with each request:

```
[
  { role: "user",  parts: [{ text: "What is the capital of Japan?" }] },
  { role: "model", parts: [{ text: "The capital of Japan is Tokyo." }] },
  { role: "user",  parts: [{ text: "And what is its population?" }] }   ← new message
]
```

This means you can ask follow-up questions, refer to previous answers, and have multi-turn conversations without repeating context.

### Commands

| Command | Description |
|---|---|
| `/exit` | Quit the chat |
| `/clear` | Clear conversation history and start fresh |
| `/model` | Show which Gemini model is currently active |

### Model fallback

`chat.js` uses the same fallback logic as `mcp.js`: it tries models from `models.json` left to right and remembers the first one that works. On quota errors it automatically switches to the next model in the list. After each response, the active model name is displayed in brackets.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | – | API key (alternative to CLI argument) |
| `GEMINI_FETCH_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |
| `GEMINI_MAX_STDIN_BUFFER_BYTES` | `1000000` | Max stdin buffer size for `mcp.js` (~1 MB) |

---

## Project Files

| File | Description |
|---|---|
| `mcp.js` | MCP server – main entry point for Claude Desktop |
| `chat.js` | Interactive CLI chat client for direct Gemini conversations |
| `models.js` | Utility script for listing, testing and updating models |
| `models.json` | Fallback chain – model list shared by `mcp.js` and `chat.js` |

---

## License

MIT
