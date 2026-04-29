// GeminiClient.js — Gemini API calls, fallback, cache integration

import { readFileSync } from 'node:fs';
import { Config }       from './Config.js';
import * as Cache       from './ModelCache.js';

// --- Load models ---

const FALLBACK_MODELS = [
  { id: 'gemini-2.5-flash',      tier: 2, desc: 'fast, capable, balanced' },
  { id: 'gemini-2.5-flash-lite', tier: 3, desc: 'lightweight, high quota' },
];

export function loadModels() {
  try {
    const raw  = readFileSync(Config.MODELS_PATH, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) throw new Error('models.json is empty or invalid.');
    // Supports both old (string[]) and new ({ id, tier, desc }[]) formats
    return list.map((m, i) =>
      typeof m === 'string'
        ? { id: m, tier: i + 1, desc: '' }
        : m
    );
  } catch (err) {
    process.stderr.write(`[gemini-bridge] ERROR loading models.json (${Config.MODELS_PATH}): ${err.message} — using fallback list.\n`);
    return FALLBACK_MODELS;
  }
}

export const MODELS = loadModels();

// --- Gemini API helpers ---

function makeUrl(modelId) {
  return `${Config.BASE_URL}models/${modelId}:generateContent?key=${Config.API_KEY}`;
}

function makeBody(promptText) {
  return JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] });
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

// --- Probe (used by gemini_status) ---

/**
 * Tests one model with a short message and refreshes its cache entry.
 * Returns { ok, model, status, error? }
 */
export async function probeModel(modelId) {
  const url        = makeUrl(modelId);
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), Config.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    makeBody('Hi'),
      signal:  controller.signal,
    });

    if (res.status === 429) {
      const { quotaMetric, retryAfterSec } = await parse429(res);
      Cache.setQuota(modelId, quotaMetric, retryAfterSec);
      return { ok: false, model: modelId, status: `quota_${quotaMetric}`, error: 'quota exceeded' };
    }

    if (res.status === 401 || res.status === 403) {
      Cache.setError(modelId);
      return { ok: false, model: modelId, status: 'error', error: `HTTP ${res.status}` };
    }

    if (!res.ok) {
      return { ok: false, model: modelId, status: 'error', error: `HTTP ${res.status}` };
    }

    const json   = await res.json();
    const result = extractResponse(json);
    if (result.blocked) {
      return { ok: false, model: modelId, status: 'error', error: result.reason };
    }

    Cache.setOk(modelId);
    return { ok: true, model: modelId, status: 'ok' };

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return { ok: false, model: modelId, status: isTimeout ? 'timeout' : 'network', error: err.message };
  } finally {
    clearTimeout(timeout);
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
export async function callGemini(promptText, targetModelId = null) {
  const log = (msg) => process.stderr.write(`[gemini-bridge] ${msg}\n`);

  const candidates = targetModelId
    ? [MODELS.find(m => m.id === targetModelId) ?? { id: targetModelId, tier: 99, desc: '' }]
    : [...MODELS].sort((a, b) => a.tier - b.tier);

  let lastError    = 'unknown';
  let lastRetry    = false;
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

    const url        = makeUrl(model.id);
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), Config.FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    makeBody(promptText),
        signal:  controller.signal,
      });

      if (res.status === 429) {
        const { quotaMetric, retryAfterSec } = await parse429(res);
        Cache.setQuota(model.id, quotaMetric, retryAfterSec);
        log(`${model.id} → quota_${quotaMetric} (retry in ${retryAfterSec}s), next...`);
        if (!bestRetryIn || retryAfterSec < bestRetryIn) bestRetryIn = retryAfterSec;
        if (quotaMetric === 'qpd') rpdCount++; else rpmCount++;
        quotaCount++;
        lastError = 'quota';
        lastRetry = false;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        Cache.setError(model.id);
        log(`${model.id} → auth error HTTP ${res.status}, skip permanently`);
        lastError = 'error';
        lastRetry = false;
        continue;
      }

      if (!res.ok) {
        log(`${model.id} → HTTP ${res.status}, next...`);
        lastError = `http:${res.status}`;
        lastRetry = false;
        continue;
      }

      const json   = await res.json();
      const result = extractResponse(json);

      if (result.blocked) {
        log(`${model.id} → response blocked (${result.reason})`);
        return { ok: false, error: 'blocked', detail: result.reason, retry: false };
      }

      Cache.setOk(model.id);
      log(`${model.id} → OK`);
      return { ok: true, text: result.text, model_used: model.id };

    } catch (err) {
      if (err.name === 'AbortError') {
        log(`${model.id} → timeout (${Config.FETCH_TIMEOUT_MS}ms)`);
        lastError = 'timeout';
        lastRetry = true;
      } else {
        log(`${model.id} → network error: ${err.message}`);
        lastError = 'network';
        lastRetry = true;
      }
    } finally {
      clearTimeout(timeout);
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
    : lastRetry;

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
