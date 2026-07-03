// GeminiModelPrioritizer.js — runtime fallback ordering (does not affect stored `tier`)

import * as Cache from './ModelCache.js';

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
export function effectivePriority(model) {
  let score = -model.tier;
  if (DEPRIORITIZE_REGEX && DEPRIORITIZE_REGEX.test(model.id)) score -= DEPRIORITIZE_PENALTY;
  score -= Cache.getFailRatio(model.id) * ADAPTIVE_FAIL_WEIGHT;
  return score;
}
