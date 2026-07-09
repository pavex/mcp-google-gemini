// Tools/AskGemini.js

import { z } from 'zod';
import { Config }        from '../Config.js';
import { callGemini }    from '../GeminiClient.js';
import { composePrompt } from '../Utils/composePrompt.js';

export const AskGemini = {
  name: 'ask_gemini',

  description: [
    'Asks a question to the Gemini AI model.',
    'Auto-selects best available model with fallback on quota/errors. Do not pass `model` — let the server choose.',
    'Use `context` to pass structured blocks (skill/data/text) before the prompt.',
    `Limits: prompt max ${Config.MAX_PROMPT_CHARS} chars; each context block max ${Config.MAX_CONTEXT_BLOCK_CHARS} chars.`,
    '',
    'Returns JSON string — always check `ok` before using `text`:',
    '  { ok: true,  text: "...", model_used: "gemini-2.5-flash" }',
    '  { ok: false, error: "quota",   retry: true,  reason: "All models on quota_rpm — retry shortly.",',
    '               best_retry_in: "43s", models_status: [{id, status, retry_in}, ...] }',
    '  { ok: false, error: "quota",   retry: false, reason: "All models hit daily quota — unavailable until tomorrow UTC.",',
    '               models_status: [{id, status, retry_in}, ...] }',
    '  { ok: false, error: "blocked", retry: false, reason: "..." }',
    '  { ok: false, error: "timeout"|"network", retry: true, reason: "..." }',
    '',
    'When ok=false and retry=true: wait for best_retry_in then try again.',
    'When ok=false and retry=false with error="quota": daily limit hit, inform the user.',
    'Never throws.',
  ].join('\n'),

  inputSchema: z.object({
    prompt: z.string().max(Config.MAX_PROMPT_CHARS).describe(`The question or instruction for Gemini (max ${Config.MAX_PROMPT_CHARS} chars).`),
    model: z.string().optional().describe('Escape hatch only — pins exact model, no fallback. Default: omit.'),
    context: z.preprocess(
      (val) => {
        if (typeof val === 'string') {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      },
      z.array(z.object({
        type: z.enum(['skill', 'data', 'text']).describe('"skill" = system instruction (sent natively), "data" = JSON/context data, "text" = freeform text'),
        text: z.string().max(Config.MAX_CONTEXT_BLOCK_CHARS).describe(`Block text content (max ${Config.MAX_CONTEXT_BLOCK_CHARS} chars).`),
      })).max(5).optional()
    ).describe('Optional structured context blocks. Must be a raw JSON array of objects. NEVER stringify this array or wrap it in a string.'),
  }),

  async handler({ prompt, model, context }) {
    const { prompt: composedPrompt, systemInstruction } = composePrompt(context, prompt);
    const result = await callGemini(composedPrompt, model ?? null, systemInstruction);
    return result;
  },
};

