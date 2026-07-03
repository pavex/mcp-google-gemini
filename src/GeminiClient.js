// GeminiClient.js — Gemini API calls, fallback, cache integration

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { Config }       from './Config.js';
import * as Cache       from './ModelCache.js';

// --- Model list ---
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

// --- Runtime ranking adjustments (do not affect stored `tier`, applied at fallback time) ---

const DEPRIORITIZE_REGEX = process.env.GEMINI_MODEL_DEPRIORITIZE_REGEX
  ? new RegExp(process.env.GEMINI_MODEL_DEPRIORITIZE_REGEX)
  : null;
const DEPRIORITIZE_PENALTY = Number(process.env.GEMINI_MODEL_DEPRIORITIZE_PENALTY) || 1000;
const ADAPTIVE_FAIL_WEIGHT = 200; // max score deduction for a model failing 100% of today's calls

/**
 * Effective priority for sorting fallback candidates — higher tries first.
 * Starts from tier (lower tier number = higher priority), then subtracts:
 *   - DEPRIORITIZE_PENALTY if the id matches GEMINI_MODEL_DEPRIORITIZE_REGEX
 *   - up to ADAPTIVE_FAIL_WEIGHT based on today's observed fail ratio
 * Does not touch the stored `tier` — purely a runtime sort order.
 */
function effectivePriority(model) {
  let score = -model.tier;
  if (DEPRIORITIZE_REGEX && DEPRIORITIZE_REGEX.test(model.id)) score -= DEPRIORITIZE_PENALTY;
  score -= Cache.getFailRatio(model.id) * ADAPTIVE_FAIL_WEIGHT;
  return score;
}

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
function persistSnapshot(models) {
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

// --- Gemini API helpers ---

function makeUrl(modelId) {
  return `${Config.BASE_URL}models/${modelId}:generateContent`;
}

function makeBody(promptText, systemInstruction = null) {
  const body = { contents: [{ parts: [{ text: promptText }] }] };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  return JSON.stringify(body);
}

/**
 * Parses a 429 response and returns { quotaMetric, retryAfterSec }.
 */
async function parse429(res) {
  let quotaMetric   = 'qpm'; // default
  let retryAfterSec = 60;

  const retryHeader = res.headers.get('retry-after');
  if (retryHeader) {
    const parsed = parseInt(retryHeader, 10);
    if (!isNaN(parsed)) retryAfterSec = parsed;
  }

  try {
    const body    = await res.json();
    const details = body?.error?.details ?? [];
    for (const d of details) {
      const metric = d?.metadata?.quota_metric ?? '';
      if (metric.endsWith('/qpd')) { quotaMetric = 'qpd'; break; }
      if (metric.endsWith('/qpm')) { quotaMetric = 'qpm'; break; }
    }
    // Fallback: look for "per day" in the error message
    if (quotaMetric === 'qpm' && body?.error?.message?.toLowerCase().includes('per day')) {
      quotaMetric = 'qpd';
    }
  } catch { /* body is not JSON — ignore */ }

  return { quotaMetric, retryAfterSec };
}

/**
 * Extracts text from a Gemini response JSON.
 * Returns { text } or { blocked, reason }.
 */
function extractResponse(json) {
  const candidate = json.candidates?.[0];

  if (candidate) {
    const finishReason = candidate.finishReason;
    if (finishReason === 'SAFETY' || (!candidate.content && finishReason)) {
      const ratings = candidate.safetyRatings
        ?.filter(r => r.blocked)
        .map(r => r.category.replace('HARM_CATEGORY_', ''))
        .join(', ');
      return { blocked: true, reason: ratings ? `blocked: ${ratings}` : `finish reason: ${finishReason}` };
    }
  }

  if (!candidate) {
    const blockReason = json.promptFeedback?.blockReason;
    if (blockReason) return { blocked: true, reason: `prompt blocked: ${blockReason}` };
  }

  return { text: candidate?.content?.parts?.[0]?.text ?? 'No response.' };
}

/**
 * Performs one generateContent request against a single model and classifies
 * the outcome. Pure — does not touch Cache or persistence; callers decide
 * what to do with the result (this is what probeModel() and callGemini()
 * used to duplicate: AbortController/timeout/fetch/status-branching).
 *
 * Returns one of:
 *   { kind: 'ok',         text }
 *   { kind: 'quota',      quotaMetric, retryAfterSec }
 *   { kind: 'auth',       status }
 *   { kind: 'http_error', status }
 *   { kind: 'blocked',    reason }
 *   { kind: 'timeout',    message }
 *   { kind: 'network',    message }
 */
async function fetchGeminiResponse(modelId, promptText, systemInstruction = null) {
  const url        = makeUrl(modelId);
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), Config.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': Config.API_KEY,
      },
      body:   makeBody(promptText, systemInstruction),
      signal: controller.signal,
    });

    if (res.status === 429) {
      const { quotaMetric, retryAfterSec } = await parse429(res);
      return { kind: 'quota', quotaMetric, retryAfterSec };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: 'auth', status: res.status };
    }
    if (!res.ok) {
      return { kind: 'http_error', status: res.status };
    }

    const json   = await res.json();
    const result = extractResponse(json);
    if (result.blocked) return { kind: 'blocked', reason: result.reason };
    return { kind: 'ok', text: result.text };

  } catch (err) {
    return err.name === 'AbortError'
      ? { kind: 'timeout', message: err.message }
      : { kind: 'network', message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Probe (used by gemini_status) ---

/**
 * Tests one model with a short message and refreshes its cache entry.
 * Returns { ok, model, status, error? }
 */
export async function probeModel(modelId) {
  const result = await fetchGeminiResponse(modelId, 'Hi');

  switch (result.kind) {
    case 'quota':
      Cache.setQuota(modelId, result.quotaMetric, result.retryAfterSec);
      persistSnapshot(MODELS);
      return { ok: false, model: modelId, status: `quota_${result.quotaMetric}`, error: 'quota exceeded' };

    case 'auth':
      Cache.setError(modelId);
      persistSnapshot(MODELS);
      return { ok: false, model: modelId, status: 'error', error: `HTTP ${result.status}` };

    case 'http_error':
      return { ok: false, model: modelId, status: 'error', error: `HTTP ${result.status}` };

    case 'blocked':
      return { ok: false, model: modelId, status: 'error', error: result.reason };

    case 'timeout':
      return { ok: false, model: modelId, status: 'timeout', error: result.message };

    case 'network':
      return { ok: false, model: modelId, status: 'network', error: result.message };

    case 'ok':
      Cache.setOk(modelId);
      persistSnapshot(MODELS);
      return { ok: true, model: modelId, status: 'ok' };
  }
}

// --- callGemini (used by ask_gemini) ---

/**
 * Formats a seconds value as a human-readable string.
 * e.g. 45 → "45s", 300 → "5m", 21600 → "6h"
 */
function formatRetryIn(sec) {
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
  return `${Math.ceil(sec / 3600)}h`;
}

/**
 * Builds the models_status array from the current cache for all candidates.
 * Used in the all-failed response to give the agent a full picture.
 */
function buildModelsStatus(candidates) {
  return candidates.map(m => {
    const entry = Cache.getEntry(m.id);
    const diffSec = entry.retry_after_ts
      ? Math.max(0, Math.ceil((entry.retry_after_ts - Date.now()) / 1000))
      : null;
    return {
      id:       m.id,
      status:   entry.status,
      retry_in: diffSec ? formatRetryIn(diffSec) : null,
    };
  });
}

/**
 * Calls the Gemini API with automatic fallback across MODELS sorted by tier.
 * If targetModelId is specified, tries only that model (no fallback).
 *
 * Always returns one of:
 *   { ok: true,  text, model_used }
 *   { ok: false, error: 'quota'|'blocked'|'timeout'|'network'|'error',
 *                retry: bool, reason: string,
 *                best_retry_in?: string, models_status?: array }
 */
export async function callGemini(promptText, targetModelId = null, systemInstruction = null) {
  const log = (msg) => process.stderr.write(`[gemini-bridge] ${msg}\n`);

  const candidates = targetModelId
    ? [MODELS.find(m => m.id === targetModelId) ?? { id: targetModelId, tier: 99, desc: '' }]
    : [...MODELS].sort((a, b) => effectivePriority(b) - effectivePriority(a));

  let lastError    = 'unknown';
  let lastRetry    = false;
  let anyRetryable = false;
  let quotaCount   = 0;
  let rpmCount     = 0;   // models on per-minute quota (short wait)
  let rpdCount     = 0;   // models on per-day quota (long wait)
  let bestRetryIn  = null; // seconds (smallest retry_after across all quota models)

  for (const model of candidates) {
    if (Cache.isBlocked(model.id)) {
      log(`${model.id} → blocked (cache), skipping`);
      const entry = Cache.getEntry(model.id);
      if (entry.retry_after_ts) {
        const diffSec = Math.ceil((entry.retry_after_ts - Date.now()) / 1000);
        if (diffSec > 0 && (!bestRetryIn || diffSec < bestRetryIn)) bestRetryIn = diffSec;
      }
      if (entry.status === 'quota_rpd') rpdCount++;
      else rpmCount++;
      quotaCount++;
      lastError = 'quota';
      continue;
    }

    const result = await fetchGeminiResponse(model.id, promptText, systemInstruction);

    switch (result.kind) {
      case 'quota': {
        Cache.setQuota(model.id, result.quotaMetric, result.retryAfterSec);
        persistSnapshot(MODELS);
        log(`${model.id} → quota_${result.quotaMetric} (retry in ${result.retryAfterSec}s), next...`);
        if (!bestRetryIn || result.retryAfterSec < bestRetryIn) bestRetryIn = result.retryAfterSec;
        if (result.quotaMetric === 'qpd') rpdCount++; else rpmCount++;
        quotaCount++;
        lastError = 'quota';
        lastRetry = false;
        continue;
      }

      case 'auth':
        Cache.setError(model.id);
        persistSnapshot(MODELS);
        log(`${model.id} → auth error HTTP ${result.status}, skip permanently`);
        lastError = 'error';
        lastRetry = false;
        continue;

      case 'http_error':
        log(`${model.id} → HTTP ${result.status}, next...`);
        lastError = `http:${result.status}`;
        lastRetry = false;
        continue;

      case 'blocked':
        log(`${model.id} → response blocked (${result.reason})`);
        return { ok: false, error: 'blocked', reason: result.reason, retry: false };

      case 'timeout':
        log(`${model.id} → timeout (${Config.FETCH_TIMEOUT_MS}ms)`);
        lastError = 'timeout';
        lastRetry = true;
        anyRetryable = true;
        continue;

      case 'network':
        log(`${model.id} → network error: ${result.message}`);
        lastError = 'network';
        lastRetry = true;
        anyRetryable = true;
        continue;

      case 'ok':
        Cache.setOk(model.id);
        persistSnapshot(MODELS);
        log(`${model.id} → OK`);
        return { ok: true, text: result.text, model_used: model.id };
    }
  }

  // --- All candidates failed — build informative response ---

  const allQuota = quotaCount === candidates.length;
  const error    = allQuota ? 'quota' : lastError;

  // retry: true only if there is a chance of quick recovery
  //   - RPM quota: worth retrying after a short wait
  //   - RPD quota only: no point retrying today
  //   - network/timeout: always worth retrying
  const hasRpmOnly  = rpmCount > 0 && rpdCount === 0;
  const hasMixed    = rpmCount > 0 && rpdCount > 0;
  const retry = allQuota
    ? (hasRpmOnly || hasMixed)   // at least one model recovers within minutes
    : (lastRetry || anyRetryable || rpmCount > 0);

  // Human-readable reason for the agent
  let reason;
  if (allQuota) {
    if (rpdCount === candidates.length) {
      reason = `All ${candidates.length} model(s) hit daily quota (quota_rpd) — service unavailable until tomorrow UTC.`;
    } else if (rpmCount === candidates.length) {
      reason = `All ${candidates.length} model(s) hit per-minute quota (quota_rpm) — retry shortly.`;
    } else {
      reason = `Mixed quota: ${rpmCount} model(s) on quota_rpm, ${rpdCount} on quota_rpd. Retry with RPM models shortly.`;
    }
  } else {
    reason = `Service unavailable: ${error}. ${lastRetry ? 'Retry may help.' : 'Check API key or model availability.'}`;
  }

  const result = {
    ok:            false,
    error,
    retry,
    reason,
    models_status: buildModelsStatus(candidates),
  };
  if (bestRetryIn !== null) result.best_retry_in = formatRetryIn(bestRetryIn);

  log(`All candidates failed. error=${error} retry=${retry} rpm=${rpmCount} rpd=${rpdCount}`);
  return result;
}
