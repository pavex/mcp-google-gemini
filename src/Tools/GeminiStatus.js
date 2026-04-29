// Tools/GeminiStatus.js

import { z }           from 'zod';
import { MODELS, probeModel } from '../GeminiClient.js';
import { listForAgent }       from '../ModelCache.js';

export const GeminiStatus = {
  name: 'gemini_status',

  description: [
    'Health check — actively probes first N models and updates the cache.',
    'Stops at the first OK model. Use for warmup or debugging.',
    'For a quick status overview without API calls, use list_models instead.',
  ].join('\n'),

  inputSchema: z.object({
    limit: z.number().int().min(1).max(10).optional()
      .describe('How many models to probe (default: 3). Stops at first OK.'),
  }),

  async handler({ limit = 3 }) {
    const toProbe = MODELS.slice(0, Math.min(limit, MODELS.length));
    const probed  = [];
    let firstOk   = null;

    for (const model of toProbe) {
      const result = await probeModel(model.id);
      probed.push(result);
      if (result.ok && !firstOk) {
        firstOk = result.model;
        break;
      }
    }

    const available = firstOk !== null;
    const summary   = available
      ? `OK — first available: ${firstOk}`
      : `All ${probed.length} probed model(s) unavailable`;

    return {
      available,
      summary,
      probed,
      models: listForAgent(MODELS),
      total_models: MODELS.length,
    };
  },
};
