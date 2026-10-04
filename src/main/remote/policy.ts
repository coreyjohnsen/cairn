import type { EventChannel, InvokeChannel, IpcEventMap } from '@shared/ipc'
import { defaultSettings } from '@shared/defaults'
import type { ConversationPatch, RemoteScopes, Settings, SystemInfo } from '@shared/types'
import type { Handlers } from '../ipc'

/**
 * What a paired phone or tablet may ask this computer to do. Everything else is refused before it reaches the app,
 * so a stolen or curious device can chat and see pictures at most, never browse files, change settings or run commands
 * unless it was explicitly given tool access.
 */

export class RemoteError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

/** Always allowed for a paired device. */
const BASE: InvokeChannel[] = [
  'settings:get',
  'system:info',
  'models:list',
  'conversations:list',
  'conversations:get',
  'conversations:create',
  'conversations:update',
  'conversations:delete',
  'conversations:truncate',
  'conversations:search',
  'chat:send',
  'chat:regenerate',
  'chat:abort',
  'chat:compact',
  'chat:uncompact',
  'chat:active',
  'chat:enhance'
]

/** Needs the "pictures" permission. */
const IMAGES: InvokeChannel[] = [
  'images:list',
  'images:jobs',
  'images:targets',
  'images:loras',
  'images:upscalers',
  'images:generate',
  'images:cancel',
  'images:delete',
  'images:favorite',
  'images:toAttachment',
  'images:import',
  'images:setMask'
]

/** Needs the "tools" permission. */
const TOOLS: InvokeChannel[] = ['chat:approve', 'tools:list']

export function allowedChannels(scopes: RemoteScopes): Set<InvokeChannel> {
  return new Set<InvokeChannel>([...BASE, ...(scopes.images ? IMAGES : []), ...(scopes.tools ? TOOLS : [])])
}

/** Every channel a device could ever be allowed (used to tell "not allowed for you" from "does not exist"). */
const ALL_REMOTE = new Set<string>([...BASE, ...IMAGES, ...TOOLS])

/* ───────────────────────────── Events ───────────────────────────── */

const EVENTS_BASE: EventChannel[] = ['chat:event', 'conversations:changed', 'conversations:removed']
const EVENTS_IMAGES: EventChannel[] = ['images:added', 'images:updated', 'images:removed', 'images:job']

export function eventAllowed<K extends EventChannel>(channel: K, payload: IpcEventMap[K], scopes: RemoteScopes): boolean {
  if (EVENTS_BASE.includes(channel)) {
    // Permission requests are only for devices that may answer them.
    if (channel === 'chat:event' && (payload as IpcEventMap['chat:event']).type === 'approval') return scopes.tools
    return true
  }
  if (EVENTS_IMAGES.includes(channel)) return scopes.images
  return false
}

/* ───────────────────────────── Redaction ───────────────────────────── */

/**
 * The settings a phone sees. Built from the defaults with only the harmless parts copied over, so a new secret added to
 * the settings later is hidden by default instead of leaking until someone remembers to remove it.
 */
export function remoteSettingsView(s: Settings): Settings {
  const blank = defaultSettings('')
  return {
    ...blank,
    appearance: s.appearance,
    defaultModel: s.defaultModel,
    chat: s.chat,
    image: {
      ...blank.image,
      loraMeta: s.image.loraMeta,
      loraPresets: s.image.loraPresets,
      aliases: s.image.aliases,
      modelDefaults: s.image.modelDefaults,
      upscaleByDefault: s.image.upscaleByDefault,
      defaultTarget: s.image.defaultTarget,
      negativePrompt: s.image.negativePrompt
    },
    onboardingDismissed: true
  }
}

export function remoteSystemInfo(i: SystemInfo): SystemInfo {
  return { ...i, dataDir: '', modelsDir: '', home: '' }
}

/* ───────────────────────────── Argument checks ───────────────────────────── */

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/
const MAX_TEXT = 400_000
const MAX_ATTACHMENTS = 12
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function id(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !SAFE_ID.test(v)) throw new RemoteError(`Invalid ${what}.`)
  return v
}

function text(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== 'string') throw new RemoteError(`${what} must be text.`)
  if (v.length > max) throw new RemoteError(`${what} is too long.`)
  return v
}

function bytes(v: unknown, what: string, max = MAX_ATTACHMENT_BYTES): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new RemoteError(`${what} must be a file.`)
  if (v.byteLength > max) throw new RemoteError(`${what} is too large.`)
  return v
}

/** The parts of a chat's settings a phone may change. The folder the assistant works in and the tools switch need tool access. */
function conversationPatch(input: unknown, scopes: RemoteScopes): ConversationPatch {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) throw new RemoteError('Invalid chat settings.')
  const allowed = new Set(['title', 'modelRef', 'systemPrompt', 'imageTarget', 'params', 'pinned', ...(scopes.tools ? ['workspace', 'toolsEnabled'] : [])])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) if (allowed.has(k)) out[k] = v
  return out as ConversationPatch
}

type Guard = (args: unknown[], scopes: RemoteScopes) => unknown[]

const GUARDS: Partial<Record<InvokeChannel, Guard>> = {
  'models:list': ([force]) => [force === true],
  'conversations:list': () => [],
  'conversations:get': ([c]) => [id(c)],
  'conversations:create': ([init], scopes) => {
    const patch = conversationPatch(init, scopes)
    // A chat started on a phone only uses tools when that phone may.
    return [scopes.tools ? patch : { ...patch, toolsEnabled: false }]
  },
  'conversations:update': ([c, patch], scopes) => [id(c), conversationPatch(patch, scopes)],
  'conversations:delete': ([c]) => [id(c)],
  'conversations:truncate': ([c, m]) => [id(c), id(m, 'message id')],
  'conversations:search': ([q]) => [text(q, 'Search', 500)],
  'chat:send': ([req], scopes) => {
    if (!isRecord(req)) throw new RemoteError('Invalid message.')
    const attachments = req.attachments === undefined ? undefined : req.attachments
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)) throw new RemoteError('Too many files attached.')
    const files = (attachments ?? []).map((a) => {
      if (!isRecord(a)) throw new RemoteError('Invalid attachment.')
      return { name: text(a.name, 'File name', 300), mime: text(a.mime, 'File type', 200), data: bytes(a.data, 'The file') }
    })
    const mode = req.mode === 'image' ? 'image' : 'chat'
    if (mode === 'image' && !scopes.images) throw new RemoteError('This device is not allowed to make pictures. Turn on Pictures for it on the computer.', 403)
    return [{ conversationId: id(req.conversationId), text: text(req.text ?? '', 'The message'), attachments: files.length ? files : undefined, mode, noTools: !scopes.tools }]
  },
  'chat:regenerate': ([c], scopes) => [id(c), { noTools: !scopes.tools }],
  'chat:abort': ([c]) => [id(c)],
  'chat:compact': ([c]) => [id(c)],
  'chat:uncompact': ([c]) => [id(c)],
  'chat:active': () => [],
  'chat:enhance': ([p]) => [text(p, 'The prompt', 20_000)],
  'chat:approve': ([a, d]) => {
    if (d !== 'allow' && d !== 'allow-chat' && d !== 'always' && d !== 'deny') throw new RemoteError('Invalid answer.')
    return [id(a, 'request id'), d]
  },
  'tools:list': ([c]) => [c === undefined ? undefined : id(c)],
  'images:list': () => [],
  'images:jobs': () => [],
  'images:loras': () => [],
  'images:upscalers': () => [],
  'images:targets': ([force]) => [force === true],
  'images:generate': ([req]) => {
    if (!isRecord(req)) throw new RemoteError('Invalid picture request.')
    text(req.prompt, 'The prompt', 20_000)
    if (req.initImageId !== undefined) id(req.initImageId, 'picture id')
    if (req.upscaleOf !== undefined) id(req.upscaleOf, 'picture id')
    if (req.conversationId !== undefined) id(req.conversationId)
    // Pictures asked for from a phone are filed under the Image Hub, not as if a chat had made them.
    return [{ ...req, source: 'hub', conversationId: undefined }]
  },
  'images:cancel': ([j]) => [id(j, 'job id')],
  'images:delete': ([ids]) => {
    if (!Array.isArray(ids) || ids.length > 500) throw new RemoteError('Invalid list of pictures.')
    return [ids.map((x) => id(x, 'picture id'))]
  },
  'images:favorite': ([i, f]) => [id(i, 'picture id'), f === true],
  'images:toAttachment': ([i]) => [id(i, 'picture id')],
  'images:import': ([name, data]) => [text(name, 'File name', 300), bytes(data, 'The picture')],
  'images:setMask': ([png]) => [bytes(png, 'The mask')]
}

/**
 * Runs one request from a paired device. Unknown or not-permitted channels are refused; the arguments are checked and
 * trimmed before the real handler sees them; the answer is cleaned of anything private.
 */
export async function dispatchRemote(handlers: Handlers, scopes: RemoteScopes, channel: unknown, rawArgs: unknown): Promise<unknown> {
  if (typeof channel !== 'string' || !ALL_REMOTE.has(channel)) throw new RemoteError('Not available on this device.', 404)
  const ch = channel as InvokeChannel
  if (!allowedChannels(scopes).has(ch)) {
    throw new RemoteError(IMAGES.includes(ch) ? 'This device is not allowed to use pictures. Turn on Pictures for it on the computer.' : 'This device is not allowed to do that. Turn on Tools for it on the computer.', 403)
  }
  const args = rawArgs === undefined ? [] : rawArgs
  if (!Array.isArray(args) || args.length > 6) throw new RemoteError('Invalid request.')
  const guard = GUARDS[ch]
  const safe = guard ? guard(args, scopes) : []
  const fn = handlers[ch] as unknown as (...a: unknown[]) => unknown
  const out = await fn(...safe)
  if (ch === 'settings:get') return remoteSettingsView(out as Settings)
  if (ch === 'system:info') return remoteSystemInfo(out as SystemInfo)
  return out
}
