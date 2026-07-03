// GeminiAPI.js — low-level Gemini REST request helpers (URL/body building, error parsing)

import { Config } from './Config.js';

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
 * what to do with the result.
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
export async function fetchGeminiResponse(modelId, promptText, systemInstruction = null) {
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
