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
    'When ok=false and retry=true: wait for best_retry_in then try again, up to ~3 attempts total.',
    'If it is still failing after that (or best_retry_in is very long, e.g. minutes+), stop retrying and tell the user Gemini is temporarily unavailable — do not loop indefinitely.',
    'When ok=false and retry=false with error="quota": daily limit hit, inform the user — do not retry until tomorrow UTC.',
    'When ok=false and error="blocked": content was blocked by safety filters — inform the user, do not retry (retrying will not help).',
    'If you passed `model` and got ok=false, retry WITHOUT `model` to let the server fall back to another model, unless you specifically need that exact model.',
    'Never throws.',
  ].join('\n'),

  inputSchema: z.object({
    prompt: z.string().max(Config.MAX_PROMPT_CHARS).describe(`The question or instruction for Gemini (max ${Config.MAX_PROMPT_CHARS} chars).`),
    model: z.string().optional().describe('Escape hatch only — pins exact model, no fallback. Default: omit.'),
    context: z.preprocess(
      (val) => {
        // Tolerate a JSON-stringified array — some LLM clients over-serialize.
        if (typeof val === 'string') {
          try {
            val = JSON.parse(val);
          } catch {
            return val; // not valid JSON either — let the array schema reject it with a clear error
          }
        }
        // Tolerate a single bare block object instead of a one-element array.
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          val = [val];
        }
        // Tolerate plain strings inside the array — treat them as freeform "text" blocks.
        if (Array.isArray(val)) {
          val = val.map((item) => (typeof item === 'string' ? { type: 'text', text: item } : item));
        }
        return val;
      },
      z.array(z.object({
        type: z.enum(['skill', 'data', 'text']).describe('"skill" = system instruction (sent natively), "data" = JSON/context data, "text" = freeform text'),
        text: z.string().max(Config.MAX_CONTEXT_BLOCK_CHARS).describe(`Block text content (max ${Config.MAX_CONTEXT_BLOCK_CHARS} chars).`),
      })).max(5).optional()
    ).describe('Optional structured context blocks. Prefer a raw JSON array of objects ([{type,text}, ...]). A JSON-stringified array, a single bare block object, or plain strings in the array are all tolerated and normalized server-side.'),
  }),

  async handler({ prompt, model, context }) {
    const { prompt: composedPrompt, systemInstruction } = composePrompt(context, prompt);
    const result = await callGemini(composedPrompt, model ?? null, systemInstruction);
    return result;
  },
};

