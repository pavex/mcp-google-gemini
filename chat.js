#!/usr/bin/env node

/**
 * Gemini CLI Chat
 *
 * Simple interactive chat with Gemini in the terminal.
 * Uses the same model configuration as mcp.js (models.json).
 * Maintains conversation history for multi-turn context.
 *
 * Usage:
 *   node chat.js [API_KEY]
 *
 * Commands:
 *   /exit  – quit
 *   /clear – clear conversation history
 *   /model – show active model
 */

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("ERROR: API key not provided. Set GEMINI_API_KEY or pass as CLI argument.");
  console.error("Usage: node chat.js [API_KEY]");
  process.exit(1);
}

const FETCH_TIMEOUT_MS = Number(process.env.GEMINI_FETCH_TIMEOUT_MS) || 30_000;
const BASE_URL         = "https://generativelanguage.googleapis.com/v1beta/";

// ---------------------------------------------------------------------------
// Load models from models.json (same as mcp.js)
// ---------------------------------------------------------------------------

function loadModels() {
  const modelsPath = path.join(__dirname, "models.json");
  try {
    const raw  = fs.readFileSync(modelsPath, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("models.json must be a non-empty array.");
    }
    return list;
  } catch (err) {
    console.error(`WARNING: Could not load models.json (${err.message}), using built-in list.`);
    return [
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-flash-lite"
    ];
  }
}

const MODELS = loadModels();

// ---------------------------------------------------------------------------
// Extract text from Gemini response (handles safety blocks)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Call Gemini API with fallback and conversation history
// ---------------------------------------------------------------------------

let activeModel = null;

async function callGemini(history) {
  let lastError = null;

  // If we already have a working model, try it first
  const modelList = activeModel
    ? [activeModel, ...MODELS.filter(m => m !== activeModel)]
    : MODELS;

  for (const model of modelList) {
    const url        = `${BASE_URL}models/${model}:generateContent?key=${API_KEY}`;
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contents: history }),
        signal:  controller.signal
      });

      const json = await res.json();

      if (res.status === 429) {
        lastError   = `${model}: quota exceeded`;
        activeModel = null; // reset – try next
        continue;
      }

      if (!res.ok) {
        lastError   = `${model}: HTTP ${res.status} – ${json.error?.message || res.statusText}`;
        activeModel = null;
        continue;
      }

      const result = extractResponse(json);

      if (result.blocked) {
        return { text: `[Gemini blocked this response – ${result.reason}]`, model };
      }

      activeModel = model; // remember working model
      return { text: result.text, model };

    } catch (err) {
      lastError   = err.name === "AbortError"
        ? `${model}: timeout`
        : `${model}: ${err.message}`;
      activeModel = null;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`All models failed. Last error: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function main() {
  const history = []; // conversation history: [{role, parts}]

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true
  });

  console.log(`Gemini CLI Chat`);
  console.log(`Models: ${MODELS[0]} (+${MODELS.length - 1} fallbacks)`);
  console.log(`Commands: /exit  /clear  /model`);
  console.log("-".repeat(50));

  const prompt = () => rl.question("You: ", async (input) => {
    const text = input.trim();

    if (!text) {
      prompt();
      return;
    }

    // Commands
    if (text === "/exit") {
      console.log("Bye!");
      rl.close();
      process.exit(0);
    }

    if (text === "/clear") {
      history.length = 0;
      activeModel    = null;
      console.log("[History cleared]");
      prompt();
      return;
    }

    if (text === "/model") {
      console.log(`[Active model: ${activeModel || "none yet – will be set on first request"}]`);
      prompt();
      return;
    }

    // Add user message to history
    history.push({ role: "user", parts: [{ text }] });

    try {
      process.stdout.write("Gemini: ");
      const { text: reply, model } = await callGemini(history);
      console.log(reply);
      console.log(`[${model}]`);

      // Add assistant reply to history
      history.push({ role: "model", parts: [{ text: reply }] });

    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      // Remove the failed user message from history to keep it consistent
      history.pop();
    }

    prompt();
  });

  prompt();
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
