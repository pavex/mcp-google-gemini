// Tools/AskGemini.js

import { z }             from 'zod';
import { callGemini }    from '../GeminiClient.js';
import { composePrompt } from '../Utils/composePrompt.js';

export const AskGemini = {
  name: 'ask_gemini',

  description: [
    'Asks a question to the Gemini AI model.',
    'Automatically selects the best available model by tier (1=best). Use `model` to override.',
    'Use `context` to pass structured blocks (skill/data/text) before the prompt.',
    '',
    'Returns JSON string — always check `ok` before using `text`:',
    '  { ok: true,  text: "...", model_used: "gemini-2.5-flash" }',
    '  { ok: false, error: "quota",   retry: true,  reason: "All models on quota_rpm — retry shortly.",',
    '               best_retry_in: "43s", models_status: [{id, status, retry_in}, ...] }',
    '  { ok: false, error: "quota",   retry: false, reason: "All models hit daily quota — unavailable until tomorrow UTC.",',
    '               models_status: [{id, status, retry_in}, ...] }',
    '  { ok: false, error: "blocked", retry: false, detail: "..." }',
    '  { ok: false, error: "timeout"|"network", retry: true, reason: "..." }',
    '',
    'When ok=false and retry=true: wait for best_retry_in then try again.',
    'When ok=false and retry=false with error="quota": daily limit hit, inform the user.',
    'Never throws.',
  ].join('\n'),

  inputSchema: z.object({
    prompt: z.string().describe('The question or instruction for Gemini.'),
    model:  z.string().optional().describe('Optional: specific model ID to use (e.g. "gemini-2.5-pro"). If omitted, best available model is selected automatically.'),
    context: z.array(z.object({
      type: z.enum(['skill', 'data', 'text']).describe('"skill" = system instruction, "data" = JSON/context data, "text" = freeform text'),
      text: z.string(),
    })).max(5).optional().describe('Optional structured context blocks prepended before the prompt.'),
  }),

  async handler({ prompt, model, context }) {
    const composed = composePrompt(context, prompt);
    const result   = await callGemini(composed, model ?? null);
    return result;
  },
};
