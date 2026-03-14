# Gemini Bridge MCP Server

A lightweight, dependency-free MCP (Model Context Protocol) server that bridges Claude Desktop with Google's Gemini AI API. Enables seamless integration of Gemini models into Claude conversations using stdio communication and JSON-RPC 2.0 protocol.

## Features

- **Single Tool**: `ask_gemini(prompt: string)` - Ask questions to Gemini AI and get responses
- **Automatic Fallback**: Switches to backup models when quota is exceeded (HTTP 429)
- **Zero Dependencies**: Pure Node.js implementation with no external packages required
- **Multi-Model Support**: Tested with multiple Gemini models for reliability
- **Lightweight Client**: Minimal footprint, fast startup, efficient resource usage

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

### Using with Claude Desktop

To integrate this MCP server with Claude Desktop:

#### Option 1: Via UI Settings

1. Open Claude Desktop and go to Settings > Developer > MCP Servers
2. Click "Add Server"
3. Enter the following configuration:
   - **Name**: Gemini Bridge (or any name you prefer)
   - **Command**: `node`
   - **Arguments**: `mcp.js` (or full path to mcp.js if not in current directory)
   - **Environment Variables**: Add `GEMINI_API_KEY=your_api_key_here`
4. Save and restart Claude Desktop

#### Option 2: Via Configuration File

Alternatively, you can configure the server using the Claude Desktop configuration file:

1. Locate your Claude Desktop configuration file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

2. Add or update the `mcpServers` section in the JSON file:

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["/path/to/your/mcp-google-gemini/mcp.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Replace `/path/to/your/mcp-google-gemini/mcp.js` with the actual path to the `mcp.js` file.

3. Save the file and restart Claude Desktop.

The `ask_gemini` tool will now be available in Claude conversations.

### Example Usage

Once configured, you can use the `ask_gemini` tool in Claude conversations. For example:

- Ask questions: "What is the capital of France?"
- Get explanations: "Explain quantum computing in simple terms"
- Generate code: "Write a Python function to calculate Fibonacci numbers"

The tool will automatically use the best available Gemini model and fall back to others if quota is exceeded.

You can also use the included `models.js` script to check model availability before using the MCP server:

```bash
node models.js [API_KEY]
```

This helps verify your API key and see which models are accessible.

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