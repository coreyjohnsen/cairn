export const ENHANCE_SYSTEM =
  'You rewrite short image ideas into one detailed prompt for a text-to-image model. ' +
  "Keep the user's subject and intent. Add concrete detail about composition, lighting, setting, lens and style. " +
  'Write a single paragraph of under 80 words with no lists, no quotes, no explanation and no preamble. Reply with the prompt only.'

/** Strip the wrappers models like to add around a rewritten prompt. */
export function cleanEnhanced(raw: string, original: string): string {
  let t = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```[a-z]*\n?|```$/gim, '')
    .trim()
  t = t.replace(/^(enhanced |improved |rewritten )?(image )?prompt\s*[:：-]\s*/i, '')
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim()
  t = t.replace(/\s*\n+\s*/g, ' ')
  if (!t || t.length > 1500) return original.trim()
  return t
}
