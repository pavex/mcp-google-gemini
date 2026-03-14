#!/usr/bin/env node

/**
 * MCP Server – Gemini Bridge v1.3.0
 * Simple bridge for calling Gemini API via MCP protocol (stdio/JSON-RPC 2.0)
 * Automatic fallback on quota error (429).
 */

// --- CONFIGURATION ---
const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;
if (!API_KEY) {
  process.stderr.write("[gemini-bridge] ERROR: API key not provided. Set GEMINI_API_KEY environment variable or pass as CLI argument.\n");
  process.stderr.write("[gemini-bridge] Usage: node mcp.js [API_KEY]\n");
  process.exit(1);
}

// Network timeouts (defensive): if Gemini stops responding we don't hang forever.
// Configurable via env var: GEMINI_FETCH_TIMEOUT_MS (milliseconds)
const FETCH_TIMEOUT_MS = Number(process.env.GEMINI_FETCH_TIMEOUT_MS) || 30_000;

// Input buffer limits (defensive): protect against unbounded stdin growth.
// Configurable via env var: GEMINI_MAX_STDIN_BUFFER_BYTES
const MAX_STDIN_BUFFER_BYTES = Number(process.env.GEMINI_MAX_STDIN_BUFFER_BYTES) || 1_000_000; // ~1MB

// Fallback chain – tested 2026-03-13, ordered from most powerful
const MODELS = [
  "gemini-2.5-flash",              // primary – best performance on free tier
  "gemini-3-flash-preview",        // backup 1 – newer, but preview
  "gemini-3.1-flash-lite-preview", // backup 2
  "gemini-2.5-flash-lite",         // backup 3 – lightest, almost always available
];

const SERVER_NAME      = "gemini-bridge";
const SERVER_VERSION   = "1.3.0";
const PROTOCOL_VERSION = "2024-11-05";
const BASE_URL         = "https://generativelanguage.googleapis.com/v1beta/";

// Redirect console to stderr – stdout is reserved for JSON-RPC messages
console.log  = console.error;
console.info = console.error;

// --- JSON-RPC helpers ---

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// --- Gemini API call with fallback ---

async function callGemini(prompt) {
  let lastError = null;

  for (const model of MODELS) {
    const url = `${BASE_URL}models/${model}:generateContent?key=${API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
        signal: controller.signal
      });

      const json = await res.json();

      // Quota – try next model
      if (res.status === 429) {
        process.stderr.write(`[gemini-bridge] ${model} → quota, trying next...\n`);
        lastError = `${model}: quota exceeded`;
        continue;
      }

      if (!res.ok) {
        process.stderr.write(`[gemini-bridge] ${model} → HTTP ${res.status}, trying next...\n`);
        lastError = `${model}: HTTP ${res.status} – ${json.error?.message || res.statusText}`;
        continue;
      }

      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "No response.";
      process.stderr.write(`[gemini-bridge] Used model: ${model}\n`);
      return { text, model };

    } catch (err) {
      if (err.name === "AbortError") {
        process.stderr.write(`[gemini-bridge] ${model} → timeout (${FETCH_TIMEOUT_MS}ms)\n`);
        lastError = `${model}: timeout`;
      } else {
        process.stderr.write(`[gemini-bridge] ${model} → network error: ${err.message}\n`);
        lastError = `${model}: ${err.message}`;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`All models failed. Last error: ${lastError}`);
}

// --- MCP tool definition ---

const TOOLS = [
  {
    name: "ask_gemini",
    description: "Asks a question to the Gemini AI model and returns its response. Automatically switches to backup model on quota error.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text of the question or instruction for Gemini." }
      },
      required: ["prompt"]
    }
  }
];

// --- Request dispatcher ---

async function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {

    case "initialize":
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      break;

    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name;

      if (toolName !== "ask_gemini") {
        sendError(id, -32601, `Unknown tool: ${toolName}`);
        break;
      }

      const prompt = params?.arguments?.prompt;

      if (!prompt || typeof prompt !== "string") {
        sendError(id, -32602, "Parameter 'prompt' is required and must be a string.");
        break;
      }

      try {
        const { text, model } = await callGemini(prompt);
        sendResult(id, {
          content: [{ type: "text", text }],
          _meta: { model } // model info for debugging
        });
      } catch (err) {
        sendResult(id, {
          content: [{ type: "text", text: `Gemini API error: ${err.message}` }],
          isError: true
        });
      }
      break;
    }

    case "notifications/initialized":
      // Notification – no response sent
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Unknown method: ${method}`);
      }
  }
}

// --- Stdin listener (newline-delimited JSON) ---

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();

  // Defensive: prevent unbounded growth of input buffer (potential DoS).
  if (Buffer.byteLength(buffer, "utf8") > MAX_STDIN_BUFFER_BYTES) {
    process.stderr.write("[gemini-bridge] ERROR: stdin buffer exceeded maximum allowed size, dropping input.\n");
    sendError(null, -32000, "Input too large");
    buffer = "";
    return;
  }

  const lines = buffer.split("\n");
  buffer = lines.pop(); // last incomplete fragment

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      sendError(null, -32700, "Parse error: invalid JSON");
      continue;
    }

    handleRequest(request).catch((err) => {
      const id = request?.id;
      if (id !== undefined) {
        sendError(id, -32603, `Internal error: ${err.message}`);
      }
    });
  }
});

// Graceful shutdown
process.stdin.on("end", () => process.exit(0));

// Prevent crash on unhandled rejection
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[gemini-bridge] UnhandledRejection: ${reason}\n`);
});
