// GeminiModelRegistry.js — model list bootstrap.
//
// .storage/models.json is empty/absent by default — there is NO hardcoded
// fallback model list. If no models are known yet, ask_gemini returns a
// clear "no_models" error telling the calling agent to run list_models with
// refresh:true (see Tools/ListModels.js, GeminiClient.js).
//
// Two discovery paths:
//   - Cheap boot-time catalog check (loadModels, below): one metadata-only
//     ListModels call, hashed and compared to the last known hash. Unchanged
//     → skip everything, boot fast with whatever is persisted. Changed (or no
//     baseline) → kick off a full refresh in the BACKGROUND (server becomes
//     ready immediately) rather than blocking startup.
//   - Full refresh (refreshModels, exported): live discovery → cheap keyword
//     pre-filter → a real probe call per surviving candidate → persist. This
//     is the expensive path (quota-consuming), only run on catalog change or
//     on-demand via list_models({ refresh: true }).
//
// Override: set GEMINI_MODELS_PATH to a JSON file with [{ id, tier, desc }]
// for full manual control (disables auto-discovery/persistence entirely).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { createHash }             from 'node:crypto';
import { Config }       from './Config.js';
import * as Cache       from './ModelCache.js';
import { probeModel }   from './GeminiProbe.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR  = resolve(__dirname, '..', '.storage');
const STORAGE_PATH = join(STORAGE_DIR, 'models.json');

// Hydrated from the persisted file (loadPersisted) and updated by refreshModels().
let lastKnownHash   = null;
let lastRefreshedAt = null;

/** ISO timestamp of the last successful full refresh, or null if never run. */
export function getLastRefreshedAt() {
  return lastRefreshedAt;
}

/**
 * Scores a Gemini model ID for auto-tiering, based only on the ID string:
 * higher version number is better, "pro" > "flash" > "flash-lite"/"flash-8b".
 * "-exp"/"-preview" get a small tie-break penalty, NOT a hard demotion — Google
 * currently ships some current-gen flagships (e.g. gemini-3.1-pro-preview) with
 * no non-preview alternative, so a big penalty would wrongly rank an old GA
 * model above the actual current flagship.
 */
export function scoreModelId(id) {
  const match = id.match(/^gemini-(\d+(?:\.\d+)?)-?(pro|flash-lite|flash-8b|flash-nano|flash)?(.*)$/);
  if (!match) return -Infinity;

  let score = parseFloat(match[1]) * 100;

  const variant = match[2] || '';
  if (variant === 'pro') score += 30;
  else if (variant === 'flash') score += 20;
  else if (variant.startsWith('flash-lite') || variant.startsWith('flash-8b') || variant.startsWith('flash-nano')) score += 10;

  const tags = match[3] || '';
  if (tags.includes('-exp')) score -= 5;
  else if (tags.includes('-preview')) score -= 3;

  return score;
}

/**
 * Cheap, deterministic pre-filter: does this ID even look like a candidate for
 * ask_gemini's plain-text-prompt use case? Requires the "gemini-" family
 * prefix (excludes gemma/lyria/nano-banana/antigravity/deep-research/...) and
 * excludes known non-chat product lines via Config.MODEL_EXCLUDE_REGEX
 * (image/tts/computer-use/robotics/... by default) — BEFORE spending a real
 * probe call on them.
 */
export function isLikelyChatModel(id) {
  return id.startsWith('gemini-') && !Config.MODEL_EXCLUDE_REGEX.test(id);
}

/** Calls the API's ListModels endpoint (paginated), filters to models usable with generateContent. */
export async function fetchAvailableModelIds() {
  const ids = [];
  let pageToken;

  do {
    const url = new URL(`${Config.BASE_URL}models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), Config.FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { 'x-goog-api-key': Config.API_KEY },
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const bodySnippet = await res.text().catch(() => '');
      throw new Error(`ListModels HTTP ${res.status} ${res.statusText}${bodySnippet ? ` — ${bodySnippet.slice(0, 300)}` : ''}`);
    }

    const json = await res.json();
    for (const m of (json.models ?? [])) {
      if ((m.supportedGenerationMethods ?? []).includes('generateContent')) {
        ids.push(m.name.replace(/^models\//, ''));
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return ids;
}

/** Stable hash of an ID list (order-independent) — used to detect catalog changes cheaply. */
export function hashCatalog(ids) {
  const sorted = [...ids].sort();
  return createHash('sha256').update(sorted.join(',')).digest('hex');
}

/**
 * Full model refresh: live discovery → cheap keyword pre-filter → a real
 * probe call per surviving candidate (confirms it actually behaves like a
 * text-chat model, not just that the API claims generateContent support) →
 * score/rank → persist.
 *
 * This is the expensive path (one ListModels call + one generateContent call
 * per candidate) — only run on catalog change or on-demand
 * (list_models refresh:true), never automatically on every boot.
 */
export async function refreshModels() {
  const rawIds       = await fetchAvailableModelIds();
  const candidateIds = rawIds.filter(isLikelyChatModel);
  const hash          = hashCatalog(candidateIds);

  const kept = [];
  for (const id of candidateIds) {
    const result = await probeModel(id);
    // Keep everything except a confirmed structural rejection ("error" — e.g.
    // wrong input modality/schema for this model). Quota/timeout/network are
    // about availability, not model type — still legitimate candidates.
    if (result.status !== 'error') kept.push(id);
  }

  const scored = kept
    .map(id => ({ id, score: scoreModelId(id) }))
    .sort((a, b) => b.score - a.score);

  const models = scored.map((m, i) => ({ id: m.id, tier: i + 1, desc: 'auto-discovered' }));

  MODELS          = models;
  lastRefreshedAt = new Date().toISOString();
  persistSnapshot(models, hash);

  process.stderr.write(
    `[gemini-bridge] Refreshed: ${models.length} model(s) confirmed usable ` +
    `(${rawIds.length} in catalog, ${candidateIds.length} after category filter, ` +
    `${candidateIds.length - kept.length} excluded on probe).\n`
  );

  return models;
}

/**
 * Best-effort write of the current model list + live cache status + catalog
 * hash to disk. Never throws.
 *
 * `catalogHash`, if provided, becomes the new persisted hash (called by
 * refreshModels() after a real discovery pass). If omitted, the previously
 * known hash is preserved — this is the common case, called after every
 * single cache mutation (setOk/setQuota/setError) from callGemini(), which
 * should not clobber the catalog hash.
 */
export function persistSnapshot(models, catalogHash) {
  if (catalogHash !== undefined) lastKnownHash = catalogHash;
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const snapshot = {
      catalog_hash: lastKnownHash,
      refreshed_at: lastRefreshedAt,
      models: models.map(m => {
        const entry = Cache.getEntry(m.id);
        return {
          id:             m.id,
          tier:           m.tier,
          desc:           m.desc,
          status:         entry.status,
          quota_metric:   entry.quota_metric,
          retry_after_ts: entry.retry_after_ts,
          last_checked:   entry.last_checked,
          ok_count:       entry.ok_count,
          fail_count:     entry.fail_count,
          count_day:      entry.count_day,
        };
      }),
    };
    writeFileSync(STORAGE_PATH, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    process.stderr.write(`[gemini-bridge] WARNING: failed to persist models.json: ${err.message}\n`);
  }
}

/**
 * Loads persisted state from disk (also hydrating lastKnownHash/lastRefreshedAt
 * and the live Cache as a side effect). Returns null if missing/invalid/old
 * flat-array format (pre-refresh-redesign) — treated as "no baseline", which
 * naturally triggers a fresh discovery.
 */
function loadPersisted() {
  if (!existsSync(STORAGE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(STORAGE_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.models)) return null;
    for (const m of raw.models) {
      if (!m.id || typeof m.tier !== 'number') return null;
    }
    for (const m of raw.models) {
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
    lastKnownHash   = raw.catalog_hash ?? null;
    lastRefreshedAt = raw.refreshed_at ?? null;
    return raw.models.map(({ id, tier, desc }) => ({ id, tier, desc }));
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
      process.stderr.write(`[gemini-bridge] ERROR loading models from GEMINI_MODELS_PATH (${customPath}): ${err.message} — no models available.\n`);
      return [];
    }
  }

  const persistedModels = loadPersisted(); // also hydrates lastKnownHash/lastRefreshedAt

  if (!Config.API_KEY) {
    // No key yet — Config.validate() (called by mcp.js right before initModels())
    // will exit with a proper error message. Skip the network call, avoid noisy failure.
    return persistedModels ?? [];
  }

  // Cheap boot-time catalog check: one metadata-only ListModels call, no
  // generateContent cost. Fail-open — any error here just means we proceed
  // with whatever was already persisted (or nothing), and try again next boot.
  let currentHash;
  try {
    const rawIds = await fetchAvailableModelIds();
    currentHash  = hashCatalog(rawIds.filter(isLikelyChatModel));
  } catch (err) {
    process.stderr.write(`[gemini-bridge] WARNING: catalog check failed (${err.message}) — using persisted data as-is.\n`);
    return persistedModels ?? [];
  }

  if (persistedModels && currentHash === lastKnownHash) {
    return persistedModels; // catalog unchanged, nothing to do — fast boot
  }

  // Catalog changed (or no baseline yet) — worth a full refresh. Runs in the
  // BACKGROUND so the server becomes ready immediately; MODELS updates live
  // once the probe sweep completes.
  process.stderr.write(
    `[gemini-bridge] Model catalog ${persistedModels ? 'changed' : 'unknown (first run)'} — refreshing in background...\n`
  );
  refreshModels().catch(err => {
    process.stderr.write(`[gemini-bridge] WARNING: background model refresh failed: ${err.message}\n`);
  });

  return persistedModels ?? [];
}

// MODELS starts empty and is populated by an explicit initModels() call from
// mcp.js — deliberately NOT auto-run via top-level await at import time.
// A module-load-time side effect that silently makes real network calls (and,
// worse, could trigger a real quota-costing probe sweep) just because
// something imported this file is exactly the kind of surprise this project
// has been debugging all session — e.g. it would otherwise fire even from
// the read-only discovery-check.js diagnostic script.
export let MODELS = [];

/** Populates MODELS. Call once, explicitly, from mcp.js after Config.validate(). */
export async function initModels() {
  MODELS = await loadModels();
  return MODELS;
}
