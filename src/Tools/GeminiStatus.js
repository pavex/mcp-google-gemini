// Tools/GeminiStatus.js

import { z } from 'zod';
import { MODELS, probeModel } from '../GeminiClient.js';
import { listForAgent, isBlocked, getEntry } from '../ModelCache.js';

export const GeminiStatus = {
  name: 'gemini_status',

  description: [
    'Health check — probes first N models and updates the cache.',
    'Skips live probe if a model already has a fresh "ok" status in cache (marked cached: true).',
    'Stops at the first OK model. Use for warmup or debugging.',
    'For a quick status overview without API calls, use list_models instead.',
  ].join('\n'),

  inputSchema: z.object({
    limit: z.number().int().min(1).max(10).optional()
      .describe('How many models to probe (default: 3). Stops at first OK.'),
  }),

  async handler({ limit = 3 }) {
    const toProbe = MODELS.slice(0, Math.min(limit, MODELS.length));
    const probed = [];
    let firstOk = null;

    for (const model of toProbe) {
      // Skip live HTTP probe if model is already confirmed ok within TTL
      if (!isBlocked(model.id) && getEntry(model.id).status === 'ok') {
        probed.push({ ok: true, model: model.id, status: 'ok', cached: true });
        firstOk = model.id;
        break;
      }

      const result = await probeModel(model.id);
      probed.push(result);
      if (result.ok && !firstOk) {
        firstOk = result.model;
        break;
      }
    }

    const available = firstOk !== null;
    const summary = available
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

