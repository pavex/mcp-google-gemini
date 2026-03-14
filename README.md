# Gemini Bridge MCP Server

A simple MCP (Model Context Protocol) server that acts as a bridge to Google's Gemini AI API. Uses stdio communication with JSON-RPC 2.0 protocol.

## Features

- Single tool: `ask_gemini(prompt: string)` - Asks a question to Gemini AI and returns the response
- Automatic fallback to backup models when quota is exceeded (HTTP 429)
- No external dependencies - pure Node.js
- Tested with multiple Gemini models

## Models

This project includes a utility script `models.js` for listing and testing available Gemini models.

### Listing and Testing Models

To list and test all available Gemini models:
```bash
node models.js [API_KEY]
```

If API_KEY is not provided as argument, it will use the `GEMINI_API_KEY` environment variable.

This will:
1. Fetch the list of available models from Gemini API
2. Test each model's accessibility and response functionality
3. Report status: ✅ available / ⚠️ quota / ❌ error

Example output:
```
🔍 Listing and testing models...

--- Available models ---
gemini-2.5-flash
gemini-3-flash-preview
gemini-3.1-flash-lite-preview
gemini-2.5-flash-lite

🧪 Testing accessibility...

✅ gemini-2.5-flash                    OK       I am Gemini 2.5 Flash, a multimodal large language model...
⚠️ gemini-3-flash-preview              QUOTA    quota exceeded
❌ gemini-3.1-flash-lite-preview       ERROR    HTTP 400: INVALID_ARGUMENT
✅ gemini-2.5-flash-lite               OK       I am Gemini 2.5 Flash Lite, an efficient and lightweight...
```

## Installation

1. Clone or download this repository
2. Install Node.js (version 18+ recommended)
3. Get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
4. Set the environment variable `GEMINI_API_KEY=your_api_key_here` or pass it as CLI argument

## Usage

### As MCP Server

Run the server:
```bash
node mcp.js [API_KEY]
```

If API_KEY is not provided as argument, it will use the `GEMINI_API_KEY` environment variable.

The server communicates via stdio using JSON-RPC 2.0. It's designed to be used with MCP clients.

## Fallback Chain

The server automatically tries models in this order when quota is hit:

1. `gemini-2.5-flash` - Primary, best performance on free tier
2. `gemini-3-flash-preview` - Backup 1, newer generation
3. `gemini-3.1-flash-lite-preview` - Backup 2
4. `gemini-2.5-flash-lite` - Backup 3, lightest model

## API Endpoint

Uses: `https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}`

## Requirements

- Node.js 18+
- Valid Gemini API key with sufficient quota

## License

This project is open source. Check individual files for license information.