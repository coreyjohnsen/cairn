import type { ModelCaps, ProviderKind } from '@shared/types'

const VISION_RE =
  /vision|(^|[-_/:.])vl([-_:.]|$)|llava|bakllava|moondream|pixtral|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|(^|[-_/])o[134]([-_]|$)|gemma-?3|qwen.*-?vl|minicpm-?v|internvl|llama-?3\.2.*vision|llama-?4|claude|gemini|mistral-(small|medium)-3|phi-?4-multimodal|glm-4\.?\d*v|smolvlm|granite.*vision/i

const REASONING_RE = /(^|[-_/:.])r1([-_:.]|$)|reason|think|qwq|(^|[-_/])o[134]([-_]|$)|deepseek-r|gpt-oss|magistral|qwen-?3|gpt-5|claude.*(opus|sonnet)-?[4-9]|sonnet-?[4-9]|opus-?[4-9]/i

/** Models that cannot chat (embeddings, speech, image generators, moderation…). */
const NON_CHAT_RE = /embed|rerank|whisper|(^|[-_/])tts|text-to-speech|dall-?e|moderation|(^|[-_/])image(-|$)|gpt-image|stable-diffusion|sdxl|flux|bge-|e5-|nomic-embed|speech|transcribe/i

export function isNonChatModel(id: string): boolean {
  return NON_CHAT_RE.test(id)
}

export function inferCaps(modelId: string, kind: ProviderKind): ModelCaps {
  if (kind === 'anthropic') {
    return { vision: true, tools: true, reasoning: REASONING_RE.test(modelId) }
  }
  return {
    vision: VISION_RE.test(modelId),
    tools: !NON_CHAT_RE.test(modelId),
    reasoning: REASONING_RE.test(modelId)
  }
}

export function mergeCaps(base: ModelCaps, override?: ModelCaps): ModelCaps {
  return { ...base, ...(override ?? {}) }
}

export function prettyModelName(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.replace(/\.gguf$/i, '')
}
