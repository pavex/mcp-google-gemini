// Tools/ListModels.js

import { z } from 'zod';
import { MODELS } from '../GeminiClient.js';
import { listForAgent } from '../ModelCache.js';
import { refreshModels, getLastRefreshedAt } from '../GeminiModelRegistry.js';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const ListModels = {
  name: 'list_models',

  description: [
    'Returns the list of configured Gemini models with their current availability status from cache.',
    'No API calls are made by default — reads only from in-memory cache.',
    '',
    'Each entry: { id, tier, desc, status, retry_in }',
    '  status: "ok" | "quota_rpm" | "quota_rpd" | "error" | "unknown"',
    '  retry_in: human-readable wait time (e.g. "43s", "2m", "6h") or null',
    '',
    'Use this to decide which model to pass to ask_gemini.',
    'Models with status "unknown" have not been tested yet — ask_gemini will try them automatically.',
    '',
    'If the model list is empty, or ask_gemini returned error:"no_models", call this',
    'with refresh:true to discover and validate available models (costs real API',
    'calls — one to list models, plus one short test call per candidate model —',
    'so only do this when actually needed, not on every session).',
    'The response also includes refreshed_at and a stale flag (true if never',
    'refreshed, or refreshed more than 30 days ago) as a hint that a refresh',
    'may be worth doing, but this is informational only — refresh is never automatic.',
  ].join('\n'),

  inputSchema: z.object({
    refresh: z.boolean().optional().describe(
      'If true, re-discovers models from the live API, filters out non-chat product lines ' +
      '(image/tts/robotics/computer-use/...), test-probes each remaining candidate with a ' +
      'short real call, and persists the validated, ranked result. Costs real API calls — ' +
      'use only when the model list looks empty, wrong, or stale. Default: false (cache only, free).'
    ),
  }),

  async handler({ refresh = false }) {
    if (refresh) {
      const models = await refreshModels();
      return {
        refreshed:    true,
        refreshed_at: getLastRefreshedAt(),
        stale:        false,
        models:       listForAgent(models),
      };
    }

    const refreshedAt = getLastRefreshedAt();
    const stale        = !refreshedAt || (Date.now() - Date.parse(refreshedAt)) > STALE_AFTER_MS;

    return {
      refreshed:    false,
      refreshed_at: refreshedAt,
      stale,
      ...(stale ? { hint: 'Model list has never been refreshed or is over 30 days old — consider calling list_models with refresh:true if results seem off.' } : {}),
      models: listForAgent(MODELS),
    };
  },
};
