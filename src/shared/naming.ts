/** File names that say nothing about the model, such as `model.gguf` or `model-Q4_K_M.gguf`. */
const GENERIC_STEM = /^(?:model|ggml-model|pytorch[-_]model|consolidated|weights|main|llm)(?:[-_.](?:(?:IQ|Q)\d\w*|BF16|F16|F32))?$/i
const SPLIT = /-\d{5}-of-\d{5}/

/**
 * A readable name for a downloaded text model whose file name is no help, taken from the
 * repository it came from. Returns undefined when the file name is already descriptive.
 */
export function suggestModelName(repo: string, filePath: string): string | undefined {
  const file = filePath.split(/[\\/]/).pop() ?? filePath
  const stem = file.replace(/\.gguf$/i, '').replace(SPLIT, '')
  if (!GENERIC_STEM.test(stem)) return undefined
  const name = (repo.split('/')[1] ?? repo).replace(/[-_.]?gguf$/i, '').trim()
  if (!name) return undefined
  const quant = /(?:^|[-_./\\])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_./\\]|$)/i.exec(filePath)?.[1]
  return quant ? `${name} ${quant.toUpperCase()}` : name
}

export type ImageFolder = 'image' | 'image/vae' | 'image/lora' | 'image/upscale' | 'image/text-encoders' | 'image/embeddings'

/** Folders under the models directory for the kinds of image files, relative to it. */
export const IMAGE_FOLDERS: Record<'model' | 'vae' | 'lora' | 'upscale' | 'text' | 'embedding', ImageFolder> = {
  model: 'image',
  vae: 'image/vae',
  lora: 'image/lora',
  upscale: 'image/upscale',
  text: 'image/text-encoders',
  embedding: 'image/embeddings'
}

const VAE_GUESS_MAX_BYTES = 1.2 * 1024 * 1024 * 1024

/**
 * Which folder a downloaded image file belongs in, going by its name (and the repository's, for
 * words that describe the whole repository). A big file is never taken for a VAE, because some
 * checkpoints have "vae" in their names.
 */
export function guessImageFolder(filePath: string, repo = '', sizeBytes?: number): ImageFolder {
  const file = (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase()
  const stem = file.replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/, '')
  const repoName = (repo.split('/')[1] ?? repo).toLowerCase()
  if (/esrgan|realesr|swinir|ultrasharp|upscal|(^|[-_ .])x[248]plus|(^|[-_ .])[248]x[-_ ]/.test(stem) || /esrgan|upscal/.test(repoName)) return IMAGE_FOLDERS.upscale
  if (/lora|lycoris|loha|locon/.test(stem) || /(^|[-_ .])lora([-_ .s]|$)/.test(repoName)) return IMAGE_FOLDERS.lora
  if (sizeBytes === undefined || sizeBytes <= VAE_GUESS_MAX_BYTES) {
    if (/(^|[-_ .])vae($|[-_ .])/.test(stem) || /^ae$/.test(stem) || /(^|[-_ .])ae$/.test(stem) && /flux|z[-_ ]?image/.test(`${repoName}${stem}`)) return IMAGE_FOLDERS.vae
  }
  if (/t5[-_ ]?xxl|umt5|clip[-_ ]?[lg]($|[-_ .])|text[-_ ]?encoder|qwen[-_ ]?3[-_ ]?4b/.test(stem)) return IMAGE_FOLDERS.text
  if (/embedding|textual[-_ ]?inversion/.test(repoName)) return IMAGE_FOLDERS.embedding
  return IMAGE_FOLDERS.model
}
