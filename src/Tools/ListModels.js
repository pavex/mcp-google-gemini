// Tools/ListModels.js

import { z }              from 'zod';
import { MODELS }         from '../GeminiClient.js';
import { listForAgent }   from '../ModelCache.js';

export const ListModels = {
  name: 'list_models',

  description: [
    'Returns the list of configured Gemini models with their current availability status from cache.',
    'No API calls are made — reads only from in-memory cache.',
    '',
    'Each entry: { id, tier, desc, status, retry_in }',
    '  status: "ok" | "quota_rpm" | "quota_rpd" | "error" | "unknown"',
    '  retry_in: human-readable wait time (e.g. "43s", "2m", "6h") or null',
    '',
    'Use this to decide which model to pass to ask_gemini.',
    'Models with status "unknown" have not been tested yet — ask_gemini will try them automatically.',
  ].join('\n'),

  inputSchema: z.object({}),

  async handler() {
    return listForAgent(MODELS);
  },
};
