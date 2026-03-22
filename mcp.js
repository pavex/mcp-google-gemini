#!/usr/bin/env node

/**
 * MCP Server – Gemini Bridge v1.7.0
 * Simple bridge for calling Gemini API via MCP protocol (stdio/JSON-RPC 2.0)
 * Automatic fallback on quota error (429).
 * Models loaded from models.json (plain array of model name strings).
 *
 * v1.6.0: Added gemini_status tool — health check without throwing.
 * v1.7.0: ask_gemini always returns structured JSON { ok, text, model } or
 *         { ok, error, retry } — never throws isError. Caller can check ok:false
 *         without wasting tokens on gemini_status round-trip.
 *
 * Error types returned in { error } field:
 *   "quota"   — all models quota exceeded         → retry: false (wait for reset)
 *   "blocked" — safety filter                     → retry: false
 *   "timeout" — network timeout                   → retry: true
 *   "network" — fetch/network error               → retry: true
 *   "http"    — unexpected HTTP status            → retry: false
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

const FETCH_TIMEOUT_MS       = Number(process.env.GEMINI_FETCH_TIMEOUT_MS)       || 30_000;
const MAX_STDIN_BUFFER_BYTES = Number(process.env.GEMINI_MAX_STDIN_BUFFER_BYTES) || 1_000_000;

// --- Load models from models.json ---

function loadModels() {
  const modelsPath = path.join(__dirname, "models.json");
  try {
    const raw  = fs.readFileSync(modelsPath, "utf8");
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
const SERVER_VERSION   = "1.7.0";
const PROTOCOL_VERSION = "2024-11-05";
const BASE_URL         = "https://generativelanguage.googleapis.com/v1beta/";

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

function extractResponse(json) {
  const candidate = json.candidates?.[0];

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

  if (!candidate) {
    const feedback = json.promptFeedback;
    if (feedback?.blockReason) {
      return { blocked: true, reason: `prompt blocked: ${feedback.blockReason}` };
    }
  }

  const text = candidate?.content?.parts?.[0]?.text ?? "No response.";
  return { text };
}

// --- Single model probe (for gemini_status) ---
// Returns { ok, model, error } — never throws.

async function probeModel(model) {
  const url        = `${BASE_URL}models/${model}:generateContent?key=${API_KEY}`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contents: [{ parts: [{ text: "Hi" }] }] }),
      signal:  controller.signal
    });
    const json = await res.json();

    if (res.status === 429) return { ok: false, model, error: "quota exceeded" };
    if (!res.ok)            return { ok: false, model, error: `HTTP ${res.status}` };

    const result = extractResponse(json);
    if (result.blocked) return { ok: false, model, error: `blocked: ${result.reason}` };

    return { ok: true, model };

  } catch (err) {
    return { ok: false, model, error: err.name === "AbortError" ? `timeout` : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Gemini API call with fallback ---
// Returns structured result — NEVER throws.
// { ok: true,  text, model }
// { ok: false, error, retry }

async function callGemini(prompt) {
  let quotaCount   = 0;
  let lastError    = "unknown";
  let lastRetry    = false;

  for (const model of MODELS) {
    const url        = `${BASE_URL}models/${model}:generateContent?key=${API_KEY}`;
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal:  controller.signal
      });
      const json = await res.json();

      if (res.status === 429) {
        log(`${model} → quota, trying next...`);
        quotaCount++;
        lastError = "quota";
        lastRetry = false;
        continue;
      }

      if (!res.ok) {
        log(`${model} → HTTP ${res.status}, trying next...`);
        lastError = `http:${res.status}`;
        lastRetry = false;
        continue;
      }

      const result = extractResponse(json);

      if (result.blocked) {
        log(`${model} → response blocked (${result.reason})`);
        // Safety block is definitive — no point trying other models
        return { ok: false, error: "blocked", detail: result.reason, retry: false };
      }

      log(`Used model: ${model}`);
      return { ok: true, text: result.text, model };

    } catch (err) {
      if (err.name === "AbortError") {
        log(`${model} → timeout (${FETCH_TIMEOUT_MS}ms)`);
        lastError = "timeout";
        lastRetry = true;
      } else {
        log(`${model} → network error: ${err.message}`);
        lastError = "network";
        lastRetry = true;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // All models failed — determine best error type
  const error = quotaCount === MODELS.length ? "quota" : lastError;
  const retry = lastRetry && quotaCount < MODELS.length;
  log(`All models failed. error=${error} retry=${retry}`);
  return { ok: false, error, retry };
}

// --- MCP tool definitions ---

const TOOLS = [
  {
    name: "ask_gemini",
    description: [
      "Asks a question to the Gemini AI model. Always returns structured JSON:",
      "  { ok: true,  text: '...', model: '...' }  — success",
      "  { ok: false, error: 'quota',   retry: false } — quota exhausted, wait for reset",
      "  { ok: false, error: 'blocked', retry: false } — safety filter",
      "  { ok: false, error: 'timeout', retry: true  } — network timeout, can retry",
      "  { ok: false, error: 'network', retry: true  } — network error, can retry",
      "Never throws. Check ok before using text."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text of the question or instruction for Gemini." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "gemini_status",
    description: "Health check — tests first N models and returns their availability status. Probing stops at first OK model.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many models to probe (default: 3). Probing stops at first OK model."
        }
      }
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
        capabilities:    { tools: {} },
        serverInfo:      { name: SERVER_NAME, version: SERVER_VERSION }
      });
      break;

    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name;

      // ---- ask_gemini ----
      if (toolName === "ask_gemini") {
        const prompt = params?.arguments?.prompt;

        if (!prompt || typeof prompt !== "string") {
          sendError(id, -32602, "Parameter 'prompt' is required and must be a string.");
          break;
        }

        const result = await callGemini(prompt);
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(result) }]
        });
        break;
      }

      // ---- gemini_status ----
      if (toolName === "gemini_status") {
        const limit   = Math.min(Math.max(1, Number(params?.arguments?.limit) || 3), MODELS.length);
        const results = [];
        let firstOk   = null;

        for (let i = 0; i < limit; i++) {
          const probe = await probeModel(MODELS[i]);
          results.push(probe);
          if (probe.ok && !firstOk) {
            firstOk = probe.model;
            break;
          }
        }

        const available = firstOk !== null;
        const summary   = available
          ? `OK — first available model: ${firstOk}`
          : `All ${results.length} probed model(s) unavailable (quota or error)`;

        log(`gemini_status: ${summary}`);
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify({ available, summary, probed: results, total_models: MODELS.length }) }]
        });
        break;
      }

      sendError(id, -32601, `Unknown tool: ${toolName}`);
      break;
    }

    case "notifications/initialized":
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Unknown method: ${method}`);
      }
  }
}

// --- Stdin listener ---

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");

  if (Buffer.byteLength(buffer, "utf8") > MAX_STDIN_BUFFER_BYTES) {
    log("ERROR: stdin buffer exceeded maximum allowed size, dropping input.");
    sendError(null, -32000, "Input too large");
    buffer = "";
    return;
  }

  const lines = buffer.split("\n");
  buffer = lines.pop();

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

process.stdin.on("end", () => process.exit(0));

process.on("unhandledRejection", (reason) => {
  log(`UnhandledRejection: ${reason}`);
});
