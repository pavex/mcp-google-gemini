// ModelCache.js — in-memory cache of model availability status
// Per-model structure: { status, retry_after_ts, quota_metric, last_checked, ok_count, fail_count, count_day }

import { Config } from './Config.js';

/**
 * @typedef {'ok'|'quota_rpm'|'quota_rpd'|'error'|'unknown'} ModelStatus
 *
 * @typedef {Object} CacheEntry
 * @property {ModelStatus}       status
 * @property {number|null}       retry_after_ts  — unix ms timestamp when quota expires
 * @property {'qpm'|'qpd'|null} quota_metric
 * @property {number|null}       last_checked    — unix ms timestamp of last successful call
 * @property {number}            ok_count        — successes today (UTC), for adaptive ranking
 * @property {number}            fail_count      — quota/error failures today (UTC)
 * @property {string|null}       count_day       — UTC date (YYYY-MM-DD) the counts belong to
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map();

function now() { return Date.now(); }
function todayUTC() { return new Date().toISOString().slice(0, 10); }

/** Returns the cache entry for a model, or a default "unknown" entry. */
export function getEntry(modelId) {
  return cache.get(modelId) ?? {
    status:         'unknown',
    retry_after_ts: null,
    quota_metric:   null,
    last_checked:   null,
    ok_count:       0,
    fail_count:     0,
    count_day:      null,
  };
}

/**
 * Returns { ok_count, fail_count, count_day } for the given outcome, resetting
 * the counters if the day has rolled over (UTC) since they were last touched.
 */
function bumpCounts(modelId, ok) {
  const prev = cache.get(modelId);
  const day  = todayUTC();
  let ok_count   = prev?.count_day === day ? (prev.ok_count ?? 0)   : 0;
  let fail_count = prev?.count_day === day ? (prev.fail_count ?? 0) : 0;
  if (ok) ok_count++; else fail_count++;
  return { ok_count, fail_count, count_day: day };
}

/** Marks a model as healthy (ok). */
export function setOk(modelId) {
  cache.set(modelId, {
    status:         'ok',
    retry_after_ts: null,
    quota_metric:   null,
    last_checked:   now(),
    ...bumpCounts(modelId, true),
  });
}

/** Marks a model as quota-limited (quota_rpm or quota_rpd). */
export function setQuota(modelId, quotaMetric, retryAfterSec) {
  const isRpd = quotaMetric === 'qpd';
  let retry_after_ts;

  if (isRpd) {
    // Midnight UTC — daily quota resets at the start of the next UTC day
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    retry_after_ts = midnight.getTime();
  } else {
    // RPM: now + Retry-After seconds (fallback 60s)
    retry_after_ts = now() + (retryAfterSec > 0 ? retryAfterSec : 60) * 1000;
  }

  cache.set(modelId, {
    status:         isRpd ? 'quota_rpd' : 'quota_rpm',
    retry_after_ts,
    quota_metric:   quotaMetric,
    last_checked:   null,
    ...bumpCounts(modelId, false),
  });
}

/** Marks a model as permanently errored (401/403). */
export function setError(modelId) {
  cache.set(modelId, {
    status:         'error',
    retry_after_ts: null,
    quota_metric:   null,
    last_checked:   null,
    ...bumpCounts(modelId, false),
  });
}

/**
 * Returns today's (UTC) fail ratio for a model: fail_count / (ok_count + fail_count).
 * Returns 0 if there's no data yet today — a model is never penalized before it's
 * actually been tried.
 */
export function getFailRatio(modelId) {
  const entry = getEntry(modelId);
  if (entry.count_day !== todayUTC()) return 0; // stale/no data for today
  const total = entry.ok_count + entry.fail_count;
  return total === 0 ? 0 : entry.fail_count / total;
}

/**
 * Restores a cache entry as-is from persisted state (no derivation/side effects).
 * Used at startup to hydrate the in-memory cache from disk.
 */
export function restore(modelId, entry) {
  cache.set(modelId, {
    status:         entry.status ?? 'unknown',
    retry_after_ts: entry.retry_after_ts ?? null,
    quota_metric:   entry.quota_metric ?? null,
    last_checked:   entry.last_checked ?? null,
    ok_count:       entry.ok_count ?? 0,
    fail_count:     entry.fail_count ?? 0,
    count_day:      entry.count_day ?? null,
  });
}

/**
 * Returns true if the model is currently blocked (quota or error).
 * An expired quota_rpm entry is reset to "unknown" and returns false.
 */
export function isBlocked(modelId) {
  const entry = getEntry(modelId);

  if (entry.status === 'error') return true;

  if (entry.status === 'quota_rpm' || entry.status === 'quota_rpd') {
    if (entry.retry_after_ts && now() < entry.retry_after_ts) return true;
    // Quota expired — reset status to unknown so the next call re-probes the model,
    // but keep today's ok/fail counts intact.
    cache.set(modelId, { ...entry, status: 'unknown', retry_after_ts: null, quota_metric: null, last_checked: null });
    return false;
  }

  if (entry.status === 'ok' && entry.last_checked) {
    // TTL expired — reset to unknown; will be re-verified on next API call
    if (now() - entry.last_checked > Config.TTL_OK_MS) {
      cache.set(modelId, { ...entry, status: 'unknown', retry_after_ts: null, quota_metric: null, last_checked: null });
    }
  }

  return false;
}

/**
 * Returns a human-readable "retry_in" string for the agent.
 * Returns null if not applicable.
 */
function retryIn(entry) {
  if (!entry.retry_after_ts) return null;
  const diffMs = entry.retry_after_ts - now();
  if (diffMs <= 0) return null;
  const diffSec = Math.ceil(diffMs / 1000);
  if (diffSec < 60)   return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.ceil(diffSec / 60)}m`;
  return `${Math.ceil(diffSec / 3600)}h`;
}

/**
 * Returns the model list enriched with current cache status — for the list_models tool.
 * @param {Array<{id: string, tier: number, desc: string}>} models
 * @returns {Array}
 */
export function listForAgent(models) {
  return models.map(m => {
    // Side effect: resets expired quota/TTL entries before reading
    isBlocked(m.id);
    const fresh = getEntry(m.id);
    return {
      id:       m.id,
      tier:     m.tier,
      desc:     m.desc,
      status:   fresh.status,
      retry_in: retryIn(fresh),
    };
  });
}
