export const ENHANCE_SYSTEM =
  'You rewrite short image ideas into one detailed prompt for a text-to-image model. ' +
  "Keep the user's subject and intent. Add concrete detail about composition, lighting, setting, lens and style. " +
  'Write a single paragraph of under 80 words with no lists, no quotes, no explanation and no preamble. Reply with the prompt only.'

/** Strip the wrappers models like to add around a rewritten prompt. */
export function cleanEnhanced(raw: string, original: string): string {
  let t = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // A model cut off while it was still thinking leaves the block open.
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^```[a-z]*\n?|```$/gim, '')
    .trim()
  t = t.replace(/^(enhanced |improved |rewritten )?(image )?prompt\s*[:：-]\s*/i, '')
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim()
  t = t.replace(/\s*\n+\s*/g, ' ')
  if (!t || t.length > 1500) return original.trim()
  return t
}

/**
 * The rewritten prompt, or an error that says what went wrong. Handing the original back unchanged looked like success
 * (the prompt box offered "Undo" for a change that never happened), and an empty reply is what a model that thinks first
 * gives when it uses up the whole reply budget on thinking.
 */
export function enhancedOrError(raw: string, original: string): string {
  const out = cleanEnhanced(raw, '')
  if (!out) {
    throw new Error(
      raw.trim()
        ? 'The model did not answer with a usable prompt. Try again, or pick another model in the chat composer.'
        : 'The model sent back no text. Models that think before they answer can use up the whole reply on thinking: turn thinking off for it, or pick another model in the chat composer.'
    )
  }
  if (out === original.trim()) throw new Error('The model gave your prompt back unchanged. Try again, or pick another model in the chat composer.')
  return out
}
