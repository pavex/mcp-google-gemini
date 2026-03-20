#!/usr/bin/env node

/**
 * Gemini Model Tester
 *
 * Usage:
 *   node models.js [API_KEY]           – list & test all models
 *   node models.js [API_KEY] --setup   – write working models to models.json
 *                                        (ordered: OK by context size desc, then QUOTA, errors excluded)
 *
 * API key can also be provided via GEMINI_API_KEY environment variable.
 *
 * Only models supporting "generateContent" are listed (excludes TTS, vision-only, robotics, etc.)
 */

const fs   = require("fs");
const path = require("path");

const BASE_URL       = "https://generativelanguage.googleapis.com/v1beta/";
const MODELS_JSON    = path.join(__dirname, "models.json");
const TEST_PROMPT    = "Reply with your model name only, nothing else.";
const REQUEST_DELAY  = 400; // ms between requests to avoid rate limiting
const DETAIL_MAX_LEN = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pad      = (s, n) => String(s).padEnd(n);
const truncate = (s, n = DETAIL_MAX_LEN) => s.length > n ? s.slice(0, n - 3) + "..." : s;
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function fetchModels(apiKey) {
  const url = `${BASE_URL}models?key=${apiKey}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      console.error(`ERROR fetching model list: HTTP ${res.status} – ${data.error?.message || res.statusText}`);
      return [];
    }
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => ({
        name:             m.name.replace("models/", ""),
        inputTokenLimit:  m.inputTokenLimit  || 0,
        outputTokenLimit: m.outputTokenLimit || 0,
      }));
  } catch (err) {
    console.error(`ERROR fetching model list: ${err.message}`);
    return [];
  }
}

async function testModel(name, apiKey) {
  const url = `${BASE_URL}models/${name}:generateContent?key=${apiKey}`;
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contents: [{ parts: [{ text: TEST_PROMPT }] }] }),
    });
    const json = await res.json();

    if (res.status === 429) {
      return { status: "QUOTA", detail: json.error?.message || "quota exceeded" };
    }
    if (!res.ok) {
      return { status: "ERROR", detail: `HTTP ${res.status}: ${json.error?.message || res.statusText}` };
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty)";
    return { status: "OK", detail: text.trim() };

  } catch (err) {
    return { status: "NETWORK", detail: err.message };
  }
}

// ---------------------------------------------------------------------------
// Setup: write working models to models.json
// ---------------------------------------------------------------------------

function writeModelsJson(results) {
  const order  = { OK: 0, QUOTA: 1 };
  const sorted = [...results]
    .filter(r => r.status === "OK" || r.status === "QUOTA")
    .sort((a, b) => {
      const oa = order[a.status] ?? 2;
      const ob = order[b.status] ?? 2;
      if (oa !== ob) return oa - ob;
      return (b.inputTokenLimit || 0) - (a.inputTokenLimit || 0);
    });

  const names      = sorted.map(r => r.name);
  const okCount    = sorted.filter(r => r.status === "OK").length;
  const quotaCount = sorted.filter(r => r.status === "QUOTA").length;

  fs.writeFileSync(MODELS_JSON, JSON.stringify(names, null, 2) + "\n", "utf8");
  console.log(`\nmodels.json updated: ${names.length} models (OK: ${okCount}, QUOTA: ${quotaCount}).`);
  console.log(`Path: ${MODELS_JSON}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args    = process.argv.slice(2);
  const doSetup = args.includes("--setup");
  const apiKey  = args.find(a => !a.startsWith("--")) || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("ERROR: API key not provided. Set GEMINI_API_KEY or pass as CLI argument.");
    console.error("Usage: node models.js [API_KEY] [--setup]");
    process.exit(1);
  }

  console.log("Fetching model list...");
  const models = await fetchModels(apiKey);

  if (models.length === 0) {
    console.log("No models found.");
    return;
  }

  models.sort((a, b) => b.inputTokenLimit - a.inputTokenLimit);
  console.log(`Found ${models.length} models supporting generateContent.\n`);

  console.log(`${"MODEL".padEnd(40)} ${"STATUS".padEnd(8)} DETAIL`);
  console.log("-".repeat(80));

  const results = [];

  for (const model of models) {
    const { status, detail } = await testModel(model.name, apiKey);
    results.push({ ...model, status, detail });
    console.log(`${pad(model.name, 40)} ${pad(status, 8)} ${truncate(detail)}`);
    await sleep(REQUEST_DELAY);
  }

  console.log("-".repeat(80));

  const ok    = results.filter(r => r.status === "OK").length;
  const quota = results.filter(r => r.status === "QUOTA").length;
  const err   = results.length - ok - quota;
  console.log(`Summary: OK: ${ok}  QUOTA: ${quota}  ERROR/NETWORK: ${err}`);

  if (doSetup) {
    writeModelsJson(results);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
