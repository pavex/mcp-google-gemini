// GeminiClient.js — orchestration: callGemini() (fallback loop, response shaping)

import { Config }             from './Config.js';
import * as Cache             from './ModelCache.js';
import { MODELS, persistSnapshot } from './GeminiModelRegistry.js';
import { effectivePriority }  from './GeminiModelPrioritizer.js';
import { fetchGeminiResponse } from './GeminiAPI.js';
import { probeModel }         from './GeminiProbe.js';

export { MODELS, probeModel };

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

  if (candidates.length === 0) {
    log('no models known — call list_models with refresh:true first');
    return {
      ok:    false,
      error: 'no_models',
      retry: false,
      reason: 'No models known yet. Call list_models with refresh:true to discover and validate available models, then retry.',
    };
  }

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
