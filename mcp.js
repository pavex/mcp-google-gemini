#!/usr/bin/env node

/**
 * MCP Server – Gemini Bridge v1.5.0
 * Simple bridge for calling Gemini API via MCP protocol (stdio/JSON-RPC 2.0)
 * Automatic fallback on quota error (429).
 * Models loaded from models.json (plain array of model name strings).
 */

const fs   = require("fs");
const path = require("path");

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

// --- Load models from models.json ---

function loadModels() {
  const modelsPath = path.join(__dirname, "models.json");
  try {
    const raw = fs.readFileSync(modelsPath, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("models.json must be a non-empty array of model name strings.");
    }
    return list;
  } catch (err) {
    process.stderr.write(`[gemini-bridge] ERROR loading models.json: ${err.message}\n`);
    process.stderr.write("[gemini-bridge] Falling back to built-in model list.\n");
    return [
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-flash-lite"
    ];
  }
}

const MODELS = loadModels();

const SERVER_NAME      = "gemini-bridge";
const SERVER_VERSION   = "1.5.0";
const PROTOCOL_VERSION = "2024-11-05";
const BASE_URL         = "https://generativelanguage.googleapis.com/v1beta/";

// Dedicated log helper – keeps stdout clean for JSON-RPC messages
const log = (msg) => process.stderr.write(`[gemini-bridge] ${msg}\n`);

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

// --- Extract text from Gemini response ---
// Returns { text } on success, { blocked, reason } if safety filter triggered.

function extractResponse(json) {
  const candidate = json.candidates?.[0];

  // Safety filter: candidate present but content missing, or finish reason is SAFETY
  if (candidate) {
    const finishReason = candidate.finishReason;
    if (finishReason === "SAFETY" || (!candidate.content && finishReason)) {
      const ratings = candidate.safetyRatings
        ?.filter(r => r.blocked)
        .map(r => r.category.replace("HARM_CATEGORY_", ""))
        .join(", ");
      const reason = ratings ? `blocked categories: ${ratings}` : `finish reason: ${finishReason}`;
      return { blocked: true, reason };
    }
  }

  // Prompt itself blocked (no candidates returned)
  if (!candidate) {
    const feedback = json.promptFeedback;
    if (feedback?.blockReason) {
      return { blocked: true, reason: `prompt blocked: ${feedback.blockReason}` };
    }
  }

  const text = candidate?.content?.parts?.[0]?.text ?? "No response.";
  return { text };
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
        log(`${model} → quota, trying next...`);
        lastError = `${model}: quota exceeded`;
        continue;
      }

      if (!res.ok) {
        log(`${model} → HTTP ${res.status}, trying next...`);
        lastError = `${model}: HTTP ${res.status} – ${json.error?.message || res.statusText}`;
        continue;
      }

      const result = extractResponse(json);

      if (result.blocked) {
        // Safety block is definitive – no point trying other models
        log(`${model} → response blocked (${result.reason})`);
        return { text: `[Gemini blocked this response – ${result.reason}]`, model };
      }

      log(`Used model: ${model}`);
      return { text: result.text, model };

    } catch (err) {
      if (err.name === "AbortError") {
        log(`${model} → timeout (${FETCH_TIMEOUT_MS}ms)`);
        lastError = `${model}: timeout`;
      } else {
        log(`${model} → network error: ${err.message}`);
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
  buffer += chunk.toString("utf8");

  // Defensive: prevent unbounded growth of input buffer (potential DoS).
  if (Buffer.byteLength(buffer, "utf8") > MAX_STDIN_BUFFER_BYTES) {
    log("ERROR: stdin buffer exceeded maximum allowed size, dropping input.");
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
  log(`UnhandledRejection: ${reason}`);
});
