// GeminiProbe.js — probeModel(): tests one model with a short live call.
//
// Deliberately only updates the in-memory Cache — does NOT persist to disk
// itself. Callers (gemini_status handler, model refresh sweep) are
// responsible for calling persistSnapshot() once after they're done, so this
// stays a dependency-free leaf module (no import of GeminiModelRegistry.js,
// which would create a circular import since the registry needs to call
// this during its own refresh sweep).

import * as Cache              from './ModelCache.js';
import { fetchGeminiResponse } from './GeminiAPI.js';

/**
 * Tests one model with a short message and updates its in-memory cache entry.
 * Returns { ok, model, status, error? }
 */
export async function probeModel(modelId) {
  const result = await fetchGeminiResponse(modelId, 'Hi');

  switch (result.kind) {
    case 'quota':
      Cache.setQuota(modelId, result.quotaMetric, result.retryAfterSec);
      return { ok: false, model: modelId, status: `quota_${result.quotaMetric}`, error: 'quota exceeded' };

    case 'auth':
      Cache.setError(modelId);
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
      return { ok: true, model: modelId, status: 'ok' };
  }
}
