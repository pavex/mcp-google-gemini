// GeminiModelRegistry.js — model list bootstrap: auto-discovery, persistence, manual override

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { Config }       from './Config.js';
import * as Cache       from './ModelCache.js';

// Default model list — last-resort fallback if auto-discovery AND persisted
// state are both unavailable (e.g. no network on very first run).
// Override: set GEMINI_MODELS_PATH to a JSON file with [{ id, tier, desc }]
// for full manual control (disables auto-discovery/persistence entirely).

const DEFAULT_MODELS = [
  { id: 'gemini-2.5-pro',        tier: 1, desc: 'best reasoning, complex tasks' },
  { id: 'gemini-2.5-flash',      tier: 2, desc: 'fast, capable, balanced' },
  { id: 'gemini-2.5-flash-lite', tier: 3, desc: 'lightweight, high quota' },
  { id: 'gemini-2.0-flash',      tier: 4, desc: 'fallback, stable' },
];

const __dirname    = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR  = resolve(__dirname, '..', '.storage');
const STORAGE_PATH = join(STORAGE_DIR, 'models.json');

// id → first-seen timestamp (ms), used when writing created_at to disk
const createdAtById = new Map();

/**
 * Scores a Gemini model ID for auto-tiering, based only on the ID string:
 * higher version number is better, "pro" > "flash" > "flash-lite"/"flash-8b",
 * GA models rank above "-exp"/"-preview" tags.
 */
function scoreModelId(id) {
  const match = id.match(/^gemini-(\d+(?:\.\d+)?)-?(pro|flash-lite|flash-8b|flash-nano|flash)?(.*)$/);
  if (!match) return -Infinity;

  let score = parseFloat(match[1]) * 100;

  const variant = match[2] || '';
  if (variant === 'pro') score += 30;
  else if (variant === 'flash') score += 20;
  else if (variant.startsWith('flash-lite') || variant.startsWith('flash-8b') || variant.startsWith('flash-nano')) score += 10;

  const tags = match[3] || '';
  if (tags.includes('-exp') || tags.includes('-preview')) score -= 100;
  else score += 50;

  return score;
}

/** Calls the API's ListModels endpoint, filters to models usable with generateContent. */
async function fetchAvailableModelIds() {
  const res = await fetch(`${Config.BASE_URL}models`, {
    headers: { 'x-goog-api-key': Config.API_KEY },
  });
  if (!res.ok) throw new Error(`ListModels HTTP ${res.status}`);
  const json = await res.json();
  return (json.models ?? [])
    .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
}

/** Auto-discovers models via the API and ranks them into tiers via scoreModelId. */
async function discoverModels() {
  const ids    = await fetchAvailableModelIds();
  const now    = Date.now();
  const scored = ids
    .map(id => ({ id, score: scoreModelId(id) }))
    .sort((a, b) => b.score - a.score);

  return scored.map((m, i) => {
    createdAtById.set(m.id, now);
    return { id: m.id, tier: i + 1, desc: 'auto-discovered' };
  });
}

/**
 * Best-effort write of the current model list + live cache status to disk. Never throws.
 *
 * Called synchronously after every single cache mutation (setOk/setQuota/setError).
 * Deliberate: the file is small, writes are infrequent relative to typical MCP call
 * volume, and "always up to date on disk" matters more here than write-batching.
 */
export function persistSnapshot(models) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const snapshot = models.map(m => {
      const entry = Cache.getEntry(m.id);
      return {
        id:             m.id,
        tier:           m.tier,
        desc:           m.desc,
        created_at:     new Date(createdAtById.get(m.id) ?? Date.now()).toISOString(),
        status:         entry.status,
        quota_metric:   entry.quota_metric,
        retry_after_ts: entry.retry_after_ts,
        last_checked:   entry.last_checked,
        ok_count:       entry.ok_count,
        fail_count:     entry.fail_count,
        count_day:      entry.count_day,
      };
    });
    writeFileSync(STORAGE_PATH, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    process.stderr.write(`[gemini-bridge] WARNING: failed to persist models.json: ${err.message}\n`);
  }
}

/** Loads persisted state from disk. Returns null if missing/invalid (triggers rediscovery). */
function loadPersisted() {
  if (!existsSync(STORAGE_PATH)) return null;
  try {
    const list = JSON.parse(readFileSync(STORAGE_PATH, 'utf8'));
    if (!Array.isArray(list) || list.length === 0) return null;
    for (const m of list) {
      if (!m.id || typeof m.tier !== 'number') return null;
    }
    for (const m of list) {
      createdAtById.set(m.id, m.created_at ? Date.parse(m.created_at) : Date.now());
      if (m.status) {
        Cache.restore(m.id, {
          status:         m.status,
          retry_after_ts: m.retry_after_ts ?? null,
          quota_metric:   m.quota_metric ?? null,
          last_checked:   m.last_checked ?? null,
          ok_count:       m.ok_count ?? 0,
          fail_count:     m.fail_count ?? 0,
          count_day:      m.count_day ?? null,
        });
      }
    }
    return list.map(({ id, tier, desc }) => ({ id, tier, desc }));
  } catch {
    return null;
  }
}

async function loadModels() {
  const customPath = process.env.GEMINI_MODELS_PATH;
  if (customPath) {
    // Manual override — full control, no auto-discovery, no persistence.
    try {
      const raw  = readFileSync(customPath, 'utf8');
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || list.length === 0) throw new Error('File is empty or not a JSON array.');
      return list.map((m, i) =>
        typeof m === 'string' ? { id: m, tier: i + 1, desc: '' } : m
      );
    } catch (err) {
      process.stderr.write(`[gemini-bridge] ERROR loading models from GEMINI_MODELS_PATH (${customPath}): ${err.message} — using defaults.\n`);
      return DEFAULT_MODELS;
    }
  }

  const persisted = loadPersisted();
  if (persisted) return persisted;

  if (!Config.API_KEY) {
    // No key yet — Config.validate() (called after this module loads) will exit
    // with a proper error message. Skip the network call, avoid noisy failure.
    return DEFAULT_MODELS;
  }

  try {
    const discovered = await discoverModels();
    persistSnapshot(discovered);
    process.stderr.write(`[gemini-bridge] Auto-discovered ${discovered.length} model(s), wrote ${STORAGE_PATH}\n`);
    return discovered;
  } catch (err) {
    process.stderr.write(`[gemini-bridge] WARNING: model auto-discovery failed (${err.message}) — using built-in defaults.\n`);
    return DEFAULT_MODELS;
  }
}

export const MODELS = await loadModels();
