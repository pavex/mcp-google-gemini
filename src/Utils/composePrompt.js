// composePrompt.js — assembles context[] blocks and the prompt into a single string

const VALID_TYPES = ['skill', 'data', 'text'];
const MAX_BLOCKS  = 5;

/**
 * Composes a structured prompt from optional context blocks and the required prompt string.
 *
 * @param {Array<{type: string, text: string}>|undefined} context
 * @param {string} prompt
 * @returns {string}
 *
 * Output format (when context is provided):
 *   [skill]
 *   ...text...
 *
 *   [data]
 *   ...text...
 *
 *   [prompt]
 *   ...prompt...
 *
 * Without context — returns the prompt string unchanged.
 */
export function composePrompt(context, prompt) {
  if (!context || context.length === 0) return prompt;

  const blocks = context
    .slice(0, MAX_BLOCKS)
    .filter(b => b && typeof b.text === 'string' && b.text.trim())
    .map(b => {
      const type = VALID_TYPES.includes(b.type) ? b.type : 'text';
      return `[${type}]\n${b.text.trim()}`;
    });

  blocks.push(`[prompt]\n${prompt}`);
  return blocks.join('\n\n');
}
