/**
 * List and test Gemini models
 * Lists all available models from API and tests accessibility/response functionality
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/";
const PROMPT   = "Answer in one sentence: What model are you?";
const MAX_DETAIL_LENGTH = 80;

async function listModels(apiKey) {
  const url = `${BASE_URL}models?key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.models) {
      const models = data.models.map(m => m.name.replace('models/', ''));
      return models;
    } else {
      console.log("No models found. Response:", data);
      return [];
    }
  } catch (error) {
    console.error("Error listing models:", error);
    return [];
  }
}

async function testModel(model, apiKey) {
  const url = `${BASE_URL}models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }] }),
    });

    const json = await res.json();

    if (res.status === 429) {
      const reason = json.error?.message || "quota exceeded";
      return { status: "QUOTA", detail: reason };
    }

    if (!res.ok) {
      return { status: "ERROR", detail: `HTTP ${res.status}: ${json.error?.message || res.statusText}` };
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty response)";
    return { status: "OK", detail: text.trim().slice(0, 120) };

  } catch (err) {
    return { status: "NETWORK", detail: err.message };
  }
}

async function main() {
  // Accept API key from CLI argument or environment variable
  const apiKey = process.argv[2] || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("ERROR: API key not provided. Set GEMINI_API_KEY environment variable or pass as CLI argument.");
    console.error("Usage: node models.js [API_KEY]");
    process.exit(1);
  }

  const models = await listModels(apiKey);

  console.log(`Found ${models.length} models.`);

  if (models.length === 0) {
    console.log("No models to test.");
    return;
  }

  console.log("🧪 Testing accessibility...");

  const pad = (s, n) => s.padEnd(n);
  const truncate = (s, maxLen = MAX_DETAIL_LENGTH) => s.length > maxLen ? s.substring(0, maxLen - 3) + "..." : s;

  for (const model of models) {
    const result = await testModel(model, apiKey);
    const icon = result.status === "OK" ? "✅" : result.status === "QUOTA" ? "⚠️ " : "❌";
    console.log(`${icon} ${pad(model, 38)} ${pad(result.status, 8)} ${truncate(result.detail)}`);
    // Small pause to not fire requests all at once
    await new Promise(r => setTimeout(r, 400));
  }
  console.log("✅ Done.");
}

main().catch(console.error);
