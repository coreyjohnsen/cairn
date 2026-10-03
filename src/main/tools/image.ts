import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import { type ToolImpl, num, str } from './types'

export function imageTools(): ToolImpl[] {
  return [
    {
      name: 'generate_image',
      description:
        'Generate an image from a text description using the user\'s configured image model. Call this whenever the user asks you to create, draw, paint, render, design or show a picture, photo, illustration, logo, wallpaper or any other image. ' +
        'Write a rich, visual prompt (subject, setting, style, lighting, composition, mood) in English, even if the user wrote briefly. Do not call it for anything that is not an image request.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the image to generate' },
          negative_prompt: { type: 'string', description: 'Things to avoid (optional; ignored by some models)' },
          width: { type: 'integer', description: 'Width in pixels (optional). Leave out unless the user asked; models give their best results near their own native size, usually 512 or 1024' },
          height: { type: 'integer', description: 'Height in pixels (optional). Same advice as width' },
          steps: { type: 'integer', description: 'Sampling steps (optional; leave unset to use the model default)' },
          seed: { type: 'integer', description: 'Seed for reproducibility (optional)' },
          count: { type: 'integer', description: 'Number of images, 1-4 (default 1)' }
        },
        required: ['prompt']
      },
      source: 'builtin',
      group: 'Images',
      defaultPermission: BUILTIN_TOOL_DEFAULTS.generate_image,
      describe: (args) => ({ kind: 'generic', title: `Generate image: ${str(args, 'prompt').slice(0, 90)}` }),
      async execute(args, ctx) {
        const prompt = str(args, 'prompt').trim()
        if (!prompt) return { content: 'prompt must not be empty', isError: true }
        const refs = await ctx.services.generateImage(
          {
            prompt,
            negativePrompt: str(args, 'negative_prompt', false) || undefined,
            width: args.width !== undefined ? num(args, 'width', 0) || undefined : undefined,
            height: args.height !== undefined ? num(args, 'height', 0) || undefined : undefined,
            steps: args.steps !== undefined ? num(args, 'steps', 0) || undefined : undefined,
            seed: args.seed !== undefined ? num(args, 'seed', -1) : undefined,
            count: Math.max(1, Math.min(4, Math.floor(num(args, 'count', 1))))
          },
          ctx
        )
        const n = refs.length
        return {
          content: `Generated ${n} image${n === 1 ? '' : 's'}. ${n === 1 ? 'It is' : 'They are'} now displayed to the user in the chat and saved to the Image Hub. ` +
            'Briefly describe what you made; do not try to embed the image yourself.',
          images: refs
        }
      }
    }
  ]
}
