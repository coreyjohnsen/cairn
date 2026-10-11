import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ChatEvent,
  ChatMessage,
  Compaction,
  ContextUsage,
  Conversation,
  CustomToolConfig,
  ImageGenRequest,
  ImageRef,
  ImageStage,
  ModelOption,
  SendRequest,
  Settings,
  ToolCall,
  ToolPermission
} from '@shared/types'
import { COMMANDS, type CommandId, DEFAULT_ARG, parseCommand } from '@shared/commands'
import { planReminder } from '@shared/plan'
import { newId } from '@shared/defaults'
import { DEFAULT_TITLE, type ConversationStore } from '../conversations'
import { emit } from '../events'
import type { LoadedAttachment, Provider, ToolDef } from '../providers/types'
import type { ApprovalPreview, ToolContext, ToolImpl, ToolResult, ToolServices } from '../tools/types'
import { ToolError } from '../tools/types'
import type { ToolRegistry } from '../tools/registry'
import { parseToolArgs, truncateMiddle } from '../util/json'
import { contextOutputLimit, maxAgentSteps, toolOutputLimit } from '../util/limits'
import { CodeIndexRegistry } from '../codeindex/index'
import type { ApprovalManager } from './approvals'
import { cleanTitle, completeText, completeTextDetailed } from './complete'
import { MIN_COMPACT_BUDGET, applyCompaction, summaryReplyTokens, asksFrom, chooseCut, isContextOverflow, keptFrom, ledgerFrom, mergeLedger, transcriptBlocks, validCompaction, writeNarrative } from './compact'
import { estimateTokens, fitHistory, historyFor, totalTokens } from './context'
import { detectImageRequest, isExplicitImageCommand } from './intent'
import { allowsCreateTool, toolsForMode } from './modes'
import { readNotes } from './notes'
import { buildSystemPrompt } from './prompt'

/** How much of a streaming tool call's arguments goes to the window to say what it is about (a file path or a command comes first). */
const TOOL_HEAD = 400

export interface ResolvedModel {
  option: ModelOption
  provider: Provider
  contextTokens?: number
}

export interface ModelResolver {
  resolve(ref: string | undefined): Promise<ResolvedModel | null>
}

export interface ImageApi {
  available(): boolean
  generate(req: ImageGenRequest, hooks: { onProgress(fraction: number, label?: string, stage?: ImageStage): void; signal: AbortSignal }): Promise<ImageRef[]>
}

export interface AttachmentApi {
  save(input: { name: string; mime: string; data: Uint8Array }): Promise<Attachment>
  load(att: Attachment): Promise<LoadedAttachment | null>
}

export interface RunnerDeps {
  getSettings(): Settings
  setToolPermission(name: string, permission: ToolPermission): void
  /** Save a tool the assistant made (with /tool) among the user's custom tools. */
  addCustomTool(cfg: CustomToolConfig): void
  conversations: ConversationStore
  /** The index of each workspace's code (what is defined where). */
  codeIndex: CodeIndexRegistry
  models: ModelResolver
  tools: ToolRegistry
  approvals: ApprovalManager
  images: ImageApi
  attachments: AttachmentApi
  emit(e: ChatEvent): void
}

interface ActiveRun {
  runId: string
  conv: Conversation
  controller: AbortController
  /** History budget (tokens) of the current request, used to size tool results. */
  budget?: number
  /** This run may not use tools, whatever the chat says (a paired phone that has not been given tool access). */
  noTools?: boolean
  /** The slash command the message started with; it shapes this run only. */
  mode?: CommandId
  /** The tools changed during the run (a new one was made), so the model is offered the new list. */
  refreshTools?: boolean
  /** Files may have changed, so the project map is made again before the next request. */
  mapStale?: boolean
}

class RunError extends Error {}

/** Tools that cannot change files, so the project map stays as it was after them. */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_files', 'find_files', 'fetch_url', 'web_search', 'find_symbol', 'file_outline', 'find_usages', 'update_plan', 'generate_image'])

/** Tools whose answer carries a reminder of the plan step. */
const PLAN_REMINDER_TOOLS = new Set(['write_file', 'edit_file', 'move_path', 'delete_path'])

function isCompleteJson(raw: string): boolean {
  try {
    JSON.parse(raw || '{}')
    return true
  } catch {
    return false
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /aborted|abort/i.test(e.message) && e.name !== 'ProviderError')
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    if (e.message === 'fetch failed' && cause) return `Could not reach the model server (${cause.code ?? cause.message ?? 'network error'}). Is it running?`
    return e.message
  }
  return String(e)
}

export class ChatRunner {
  private runs = new Map<string, ActiveRun>()
  private chatAllow = new Map<string, Set<string>>()
  /** How many real tokens the server counts for each token this app estimates, learned per chat from its replies. */
  private calibration = new Map<string, number>()

  constructor(private d: RunnerDeps) {}

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId)
  }

  activeIds(): string[] {
    return [...this.runs.keys()]
  }

  abort(conversationId: string): void {
    const run = this.runs.get(conversationId)
    if (!run) return
    run.controller.abort()
    this.d.approvals.cancelConversation(conversationId)
  }

  abortAll(): void {
    for (const id of [...this.runs.keys()]) this.abort(id)
  }

  /* ───────────────────────────── entry points ───────────────────────────── */

  async send(req: SendRequest): Promise<{ runId: string }> {
    const conv = this.d.conversations.get(req.conversationId)
    if (!conv) throw new Error('Conversation not found')
    if (this.runs.has(conv.id)) throw new Error('This chat is already generating a response.')
    const text = req.text ?? ''
    if (!text.trim() && !(req.attachments?.length ?? 0)) throw new Error('Nothing to send.')
    // A message that starts with /plan, /build, /tool, /init or /review: the text after it is the request.
    const cmd = req.mode === 'image' ? null : parseCommand(text)
    if (cmd) {
      const def = COMMANDS.find((c) => c.id === cmd.id)!
      if (def.arg === 'required' && !cmd.text) throw new Error(`Say what to work on after ${def.name}, for example: ${def.name} ${def.hint}`)
      if (req.noTools) throw new Error(`${def.name} needs tools, and this device is not allowed to use them.`)
      if (!conv.toolsEnabled) throw new Error(`Turn tools on (the wrench under the message box) to use ${def.name}.`)
    }
    const content = cmd ? cmd.text || DEFAULT_ARG[cmd.id] || '' : text

    const attachments: Attachment[] = []
    for (const a of req.attachments ?? []) attachments.push(await this.d.attachments.save(a))

    const userMsg: ChatMessage = {
      id: newId('m_'),
      role: 'user',
      createdAt: Date.now(),
      content,
      attachments: attachments.length ? attachments : undefined,
      command: cmd?.id,
      status: 'done'
    }
    this.d.conversations.upsertMessage(conv.id, userMsg)
    if (conv.title === DEFAULT_TITLE && !conv.titleSet) {
      const titleSource = isExplicitImageCommand(text) ? (detectImageRequest(text) ?? text) : content
      const first = (titleSource.trim().split('\n')[0] || attachments[0]?.name || DEFAULT_TITLE).slice(0, 48)
      this.d.conversations.setAutoTitle(conv.id, first)
    }

    const run = this.begin(conv, req.noTools, cmd?.id)
    this.d.emit({ type: 'message', runId: run.runId, conversationId: conv.id, message: userMsg })
    void this.execute(run, async () => {
      const explicit = req.mode === 'image' || isExplicitImageCommand(text)
      if (explicit) {
        const prompt = detectImageRequest(text) ?? text.trim()
        await this.runDirectImage(run, prompt)
        return
      }
      await this.runAgent(run, content)
    })
    return { runId: run.runId }
  }

  async regenerate(conversationId: string, opts?: { noTools?: boolean }): Promise<{ runId: string }> {
    const conv = this.d.conversations.get(conversationId)
    if (!conv) throw new Error('Conversation not found')
    if (this.runs.has(conv.id)) throw new Error('This chat is already generating a response.')
    let lastUser = -1
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        lastUser = i
        break
      }
    }
    if (lastUser < 0) throw new Error('There is no message to regenerate from.')
    conv.messages.splice(lastUser + 1)
    this.d.conversations.markDirty(conv.id)
    const run = this.begin(conv, opts?.noTools, conv.messages[lastUser].command as CommandId | undefined)
    void this.execute(run, () => this.runAgent(run, conv.messages[lastUser].content))
    return { runId: run.runId }
  }

  /** Summarize the older part of a chat now, to free the model's memory. Runs in the background like a reply. */
  async compactNow(conversationId: string): Promise<void> {
    const conv = this.d.conversations.get(conversationId)
    if (!conv) throw new Error('Conversation not found')
    if (this.runs.has(conv.id)) throw new Error('Wait for the reply to finish, then summarize.')
    const settings = this.d.getSettings()
    const resolved = await this.d.models.resolve(conv.modelRef || settings.defaultModel)
    if (!resolved) throw new Error('No model selected. Pick a model under the message box first.')
    const prep = await this.prepare(conv, resolved)
    const budget = prep.budget || Math.max(4000, Math.floor((resolved.contextTokens ?? 16000) * 0.7))
    const from = keptFrom(conv.messages, conv.compaction)
    const cut = chooseCut(conv.messages, from, Math.max(600, Math.floor(budget * 0.25)))
    if (cut <= from || totalTokens(conv.messages.slice(from, cut)) < 300) throw new Error('There is not enough earlier conversation to summarize yet.')
    const run = this.begin(conv)
    void this.execute(run, async () => {
      await this.compact(run, conv, resolved, { budget, tailFraction: 0.25, thinking: prep.thinking, signal: run.controller.signal })
    })
  }

  /** Go back to sending the model the whole chat. */
  uncompact(conversationId: string): Conversation | null {
    const conv = this.d.conversations.get(conversationId)
    if (!conv) return null
    if (this.runs.has(conv.id)) throw new Error('Wait for the reply to finish first.')
    conv.compaction = undefined
    this.d.conversations.markDirty(conv.id)
    this.d.emit({ type: 'compaction', conversationId: conv.id })
    return conv
  }

  /* ───────────────────────────── plumbing ───────────────────────────── */

  private begin(conv: Conversation, noTools?: boolean, mode?: CommandId): ActiveRun {
    const run: ActiveRun = { runId: newId('run_'), conv, controller: new AbortController(), noTools: noTools || undefined, mode }
    this.runs.set(conv.id, run)
    this.d.emit({ type: 'run-start', runId: run.runId, conversationId: conv.id })
    return run
  }

  private async execute(run: ActiveRun, work: () => Promise<void>): Promise<void> {
    const { conv } = run
    let outcome: 'done' | 'aborted' | 'error' = 'done'
    let error: string | undefined
    try {
      await work()
      if (run.controller.signal.aborted) outcome = 'aborted'
    } catch (e) {
      if (run.controller.signal.aborted || isAbortError(e)) outcome = 'aborted'
      else {
        outcome = 'error'
        error = errMsg(e)
        const last = conv.messages[conv.messages.length - 1]
        if (!(last && last.role === 'assistant' && last.status === 'error')) {
          const m: ChatMessage = { id: newId('m_'), role: 'assistant', createdAt: Date.now(), content: '', status: 'error', error }
          this.d.conversations.upsertMessage(conv.id, m)
          this.d.emit({ type: 'message', runId: run.runId, conversationId: conv.id, message: m })
        }
      }
    } finally {
      this.runs.delete(conv.id)
      this.d.approvals.cancelConversation(conv.id)
      // Anything still streaming was interrupted.
      for (const m of conv.messages) {
        if (m.status === 'streaming') {
          m.status = outcome === 'error' ? 'error' : 'aborted'
          this.d.emit({ type: 'message', runId: run.runId, conversationId: conv.id, message: m })
        }
      }
      this.d.conversations.markDirty(conv.id)
      await this.d.conversations.flush()
      this.d.emit({ type: 'run-end', runId: run.runId, conversationId: conv.id, outcome, error })
      emit('conversations:changed', this.d.conversations.summary(conv))
    }
    if (outcome === 'done') void this.maybeTitle(conv)
  }

  private emitMessage(run: ActiveRun, message: ChatMessage): void {
    this.d.conversations.upsertMessage(run.conv.id, message)
    this.d.emit({ type: 'message', runId: run.runId, conversationId: run.conv.id, message })
  }

  /* ───────────────────────────── direct image mode ───────────────────────────── */

  private async runDirectImage(run: ActiveRun, prompt: string): Promise<void> {
    const { conv } = run
    const settings = this.d.getSettings()
    if (!this.d.images.available()) {
      throw new RunError('No image model is set up yet. Open Models → Image models to add one (built-in, ComfyUI, AUTOMATIC1111 or an API).')
    }
    const toolCallId = newId('call_')
    const assistant: ChatMessage = {
      id: newId('m_'),
      role: 'assistant',
      createdAt: Date.now(),
      content: '',
      status: 'streaming',
      model: 'Image generator',
      toolCalls: [{ id: toolCallId, name: 'generate_image', arguments: JSON.stringify({ prompt }) }]
    }
    this.emitMessage(run, assistant)
    const started = Date.now()
    let refs: ImageRef[] = []
    let failure: string | undefined
    try {
      refs = await this.d.images.generate(
        {
          prompt,
          negativePrompt: settings.image.negativePrompt || undefined,
          width: 0,
          height: 0,
          seed: -1,
          count: 1,
          source: 'chat',
          conversationId: conv.id,
          target: conv.imageTarget
        },
        {
          signal: run.controller.signal,
          onProgress: (fraction, label) =>
            this.d.emit({ type: 'tool-progress', runId: run.runId, conversationId: conv.id, toolCallId, progress: fraction, label })
        }
      )
    } catch (e) {
      if (run.controller.signal.aborted) throw e
      failure = errMsg(e)
    }
    const toolMsg: ChatMessage = {
      id: newId('m_'),
      role: 'tool',
      createdAt: Date.now(),
      toolCallId,
      toolName: 'generate_image',
      content: failure ? `Image generation failed: ${failure}` : `Generated ${refs.length} image${refs.length === 1 ? '' : 's'} for the prompt: ${prompt}`,
      isError: Boolean(failure),
      images: refs.length ? refs : undefined
    }
    this.emitMessage(run, toolMsg)
    assistant.status = failure ? 'error' : 'done'
    assistant.error = failure
    assistant.durationMs = Date.now() - started
    this.emitMessage(run, assistant)
  }

  /* ───────────────────────────── agent loop ───────────────────────────── */

  private async runAgent(run: ActiveRun, lastUserText: string): Promise<void> {
    const { conv } = run
    const settings = this.d.getSettings()
    const resolved = await this.d.models.resolve(conv.modelRef || settings.defaultModel)
    if (!resolved) throw new RunError('No model selected. Pick a model under the message box, or add one in Models.')
    const { option, provider } = resolved

    const imageAvailable = this.d.images.available()
    const toolsWanted = conv.toolsEnabled && !run.noTools && option.caps.tools !== false

    // Models that cannot call tools still get "draw me a …" requests routed to the image generator.
    if (!toolsWanted && imageAvailable && settings.chat.detectImageIntent) {
      const prompt = detectImageRequest(lastUserText)
      if (prompt) {
        await this.runDirectImage(run, prompt)
        return
      }
    }

    const prep = await this.prepare(conv, resolved, run.noTools, run.mode)
    const { system: system0, params, thinking, budget, workspace } = prep
    let toolImpls = prep.toolImpls
    let toolDefs = prep.toolDefs
    let toolMap = new Map(toolImpls.map((t) => [t.name, t]))

    run.budget = budget
    const maxSteps = maxAgentSteps(settings)
    const signal = run.controller.signal

    // A summary left over from messages that have since been removed no longer describes this chat.
    if (conv.compaction && !validCompaction(conv.messages, conv.compaction)) {
      conv.compaction = undefined
      this.d.emit({ type: 'compaction', conversationId: conv.id })
    }
    const toolsOn = toolDefs.length > 0
    const fixedTokens = estimateTokens(system0) + estimateTokens(JSON.stringify(toolDefs))
    // Estimates are rough, most of all for code; the server's own count of the last request corrects them.
    let scale = this.calibration.get(conv.id) ?? 1.1
    const autoCompact = settings.chat.autoCompact !== false && budget >= MIN_COMPACT_BUDGET
    const trigger = Math.min(95, Math.max(40, settings.chat.compactAt || 75)) / 100
    const historyNow = () => historyFor(applyCompaction(conv.messages, conv.compaction), toolsOn)
    const compactArgs = (tailFraction: number) => ({ budget, tailFraction, thinking, signal })

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return
      // A tool made during this run is on offer from the next request. The plan can have changed too, so the prompt is rebuilt.
      if (run.refreshTools) {
        run.refreshTools = false
        toolImpls = this.pickTools(conv, option, run.noTools, run.mode)
        toolDefs = toolImpls.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
        toolMap = new Map(toolImpls.map((t) => [t.name, t]))
      }
      if (run.mapStale) {
        run.mapStale = false
        await prep.refreshMap()
      }
      const system = prep.buildSystem(toolImpls)
      let history = historyNow()
      // Past the threshold: fold the older messages into a summary instead of letting them be dropped.
      if (autoCompact && totalTokens(history) * scale > budget * trigger) {
        // A small tail leaves room for several more steps before the next summary is needed.
        if (await this.compact(run, conv, resolved, compactArgs(0.22))) history = historyNow()
        // Still over the limit (one very large result, say): summarize harder rather than let the oldest turns be dropped.
        if (!signal.aborted && totalTokens(history) * scale > budget && (await this.compact(run, conv, resolved, compactArgs(0.1)))) history = historyNow()
        if (signal.aborted) return
      }
      history = fitHistory(history, budget ? budget / scale : 0)
      const assistant: ChatMessage = {
        id: newId('m_'),
        role: 'assistant',
        createdAt: Date.now(),
        content: '',
        status: 'streaming',
        model: option.name
      }
      this.emitMessage(run, assistant)
      const started = Date.now()

      const calls = new Map<number, { id: string; name: string; args: string }>()
      let pendingText = ''
      let pendingReasoning = ''
      let toolsChanged = false
      let timer: NodeJS.Timeout | null = null
      let finishReason: string | undefined
      const flush = () => {
        timer = null
        // A tool call is only shown once the model has sent all of it. Say what it is writing meanwhile, so a long file does not look like a hang.
        if (toolsChanged) {
          toolsChanged = false
          this.d.emit({
            type: 'tool-stream',
            runId: run.runId,
            conversationId: conv.id,
            messageId: assistant.id,
            calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ name: c.name, chars: c.args.length, head: c.args.slice(0, TOOL_HEAD) }))
          })
        }
        if (!pendingText && !pendingReasoning) return
        this.d.emit({
          type: 'delta',
          runId: run.runId,
          conversationId: conv.id,
          messageId: assistant.id,
          content: pendingText || undefined,
          reasoning: pendingReasoning || undefined
        })
        pendingText = ''
        pendingReasoning = ''
        this.d.conversations.markDirty(conv.id)
      }
      const schedule = () => {
        if (!timer) timer = setTimeout(flush, 40)
      }

      let overflowRetried = false
      for (;;) {
        try {
          for await (const ev of provider.stream({
            model: option.id,
            system,
            messages: history,
            tools: toolDefs,
            params,
            thinking,
            signal,
            loadAttachment: (a) => this.d.attachments.load(a)
          })) {
            if (ev.type === 'text') {
              assistant.content += ev.text
              pendingText += ev.text
              schedule()
            } else if (ev.type === 'reasoning') {
              assistant.reasoning = (assistant.reasoning ?? '') + ev.text
              pendingReasoning += ev.text
              schedule()
            } else if (ev.type === 'tool_call') {
              const cur = calls.get(ev.index) ?? { id: '', name: '', args: '' }
              if (ev.id) cur.id = ev.id
              if (ev.name) cur.name = ev.name
              if (ev.args) cur.args += ev.args
              calls.set(ev.index, cur)
              toolsChanged = true
              schedule()
            } else if (ev.type === 'usage') {
              assistant.usage = {
                promptTokens: ev.promptTokens ?? assistant.usage?.promptTokens,
                completionTokens: ev.completionTokens ?? assistant.usage?.completionTokens,
                tokensPerSecond: ev.tokensPerSecond ?? assistant.usage?.tokensPerSecond
              }
            } else if (ev.type === 'finish') {
              finishReason = ev.reason
            }
          }
          break
        } catch (e) {
          // The server said the request does not fit its memory. Nothing of the reply has arrived yet, so summarize
          // harder and ask again once, rather than ending the task.
          if (!overflowRetried && !signal.aborted && isContextOverflow(e) && !assistant.content && !assistant.reasoning && calls.size === 0) {
            overflowRetried = true
            scale = Math.min(2.5, scale * 1.3)
            this.calibration.set(conv.id, scale)
            const base = budget || Math.floor((resolved.contextTokens ?? 8192) * 0.6)
            if (settings.chat.autoCompact !== false) await this.compact(run, conv, resolved, { budget: base, tailFraction: 0.15, thinking, signal })
            if (signal.aborted) return
            history = fitHistory(historyNow(), Math.floor((base / scale) * 0.85))
            continue
          }
          if (timer) clearTimeout(timer)
          flush()
          assistant.durationMs = Date.now() - started
          if (signal.aborted || isAbortError(e)) {
            assistant.status = 'aborted'
            this.emitMessage(run, assistant)
            return
          }
          assistant.status = 'error'
          assistant.error = errMsg(e)
          this.emitMessage(run, assistant)
          throw e
        }
      }
      if (timer) clearTimeout(timer)
      flush()

      // Learn how this model's token count compares with the estimate, and tell the window how full its memory is.
      const sentEstimate = fixedTokens + totalTokens(history)
      const real = assistant.usage?.promptTokens
      if (real && sentEstimate > 200) {
        scale = Math.min(2.5, Math.max(0.7, scale * 0.5 + (real / sentEstimate) * 0.5))
        this.calibration.set(conv.id, scale)
      }
      if (resolved.contextTokens) {
        const usage: ContextUsage = { used: Math.round((real ?? sentEstimate * scale) + (assistant.usage?.completionTokens ?? 0)), window: resolved.contextTokens, at: Date.now() }
        conv.contextUsage = usage
        this.d.emit({ type: 'context', conversationId: conv.id, usage })
      }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => ({ id: c.id || newId('call_'), name: c.name, arguments: c.args.trim() || '{}' }))
        .filter((c) => c.name)

      assistant.durationMs = Date.now() - started
      if (assistant.usage && assistant.usage.tokensPerSecond === undefined && assistant.usage.completionTokens && assistant.durationMs > 500) {
        assistant.usage.tokensPerSecond = assistant.usage.completionTokens / (assistant.durationMs / 1000)
      }
      if (toolCalls.length) assistant.toolCalls = toolCalls
      if (!assistant.content && !assistant.reasoning && !toolCalls.length) assistant.notice = 'The model returned an empty response.'
      else if (finishReason === 'length' || finishReason === 'max_tokens') assistant.notice = 'The response was cut off because the token limit was reached.'
      else if (thinking === 'off' && assistant.reasoning) {
        assistant.notice = 'Thinking is set to Off, but this model reasoned anyway. Some models and servers cannot switch it off.'
      }
      assistant.status = 'done'
      this.emitMessage(run, assistant)

      if (!toolCalls.length) return

      const cutOff = finishReason === 'length' || finishReason === 'max_tokens'
      for (const tc of toolCalls) {
        if (signal.aborted) return
        await this.runTool(run, toolMap, tc, workspace, cutOff)
      }
    }

    const notice: ChatMessage = {
      id: newId('m_'),
      role: 'assistant',
      createdAt: Date.now(),
      content: '',
      status: 'done',
      notice: `Stopped after ${maxSteps} tool steps. Send a message to let the assistant continue.`
    }
    this.emitMessage(run, notice)
  }

  /** Everything one request to the model is built from: the tools on offer, the system prompt, sampling and the room left for the chat. */
  /** The tools to offer for this message: what the chat allows, narrowed by the command it started with. */
  private pickTools(conv: Conversation, option: ModelOption, noTools?: boolean, mode?: CommandId): ToolImpl[] {
    const toolsWanted = conv.toolsEnabled && !noTools && option.caps.tools !== false
    if (!toolsWanted) return []
    return toolsForMode(mode, this.d.tools.forRun(this.d.images.available(), { allow: allowsCreateTool(mode) ? ['create_tool'] : [] }))
  }

  /** Everything one request to the model is built from: the tools on offer, the system prompt, sampling and the room left for the chat. */
  private async prepare(conv: Conversation, resolved: ResolvedModel, noTools?: boolean, mode?: CommandId) {
    const settings = this.d.getSettings()
    const { option } = resolved
    const toolImpls: ToolImpl[] = this.pickTools(conv, option, noTools, mode)
    const toolDefs: ToolDef[] = toolImpls.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    const workspace = (conv.workspace || settings.agent.workspace || '').trim() || null
    const notes = toolImpls.length ? await readNotes(workspace) : null
    // A map of the project's code for the prompt: sized to the model's memory, and left out when the index tools are off.
    let projectMap = ''
    const mapChars = Math.max(1000, Math.min(4500, Math.floor((resolved.contextTokens ?? 8192) * 0.05 * 3.6)))
    const refreshMap = async () => {
      if (!workspace || !toolImpls.some((t) => t.name === 'find_symbol')) return
      try {
        const idx = this.d.codeIndex.get(workspace)
        await idx.refresh()
        projectMap = idx.repoMap(mapChars)
      } catch {
        projectMap = ''
      }
    }
    await refreshMap()
    const buildSystem = (impls: ToolImpl[]) => buildSystemPrompt(settings, conv, impls, workspace, { notes, mode, projectMap })
    const system = buildSystem(toolImpls)
    const params = {
      temperature: conv.params.temperature ?? settings.chat.temperature,
      topP: conv.params.topP ?? settings.chat.topP,
      maxTokens: conv.params.maxTokens || settings.chat.maxTokens || undefined
    }
    const thinkingMode = conv.params.thinking ?? settings.chat.thinking ?? 'auto'
    const thinking = thinkingMode === 'auto' ? undefined : thinkingMode
    // What is left of the model's memory for the conversation once the system prompt, the tool list and the reply are set aside.
    let budget = settings.chat.contextBudget
    if (!budget && resolved.contextTokens) {
      const reserve = (params.maxTokens ?? 2048) + estimateTokens(system) + estimateTokens(JSON.stringify(toolDefs))
      budget = resolved.contextTokens - reserve
      if (budget < 1000) budget = Math.floor(resolved.contextTokens * 0.6)
    }
    return { toolImpls, toolDefs, system, buildSystem, refreshMap, params, thinking, budget, workspace }
  }

  /**
   * Replace the older part of the chat with a summary, keeping the most recent messages as they are. The summary has two
   * parts: a list of every tool call, made from the messages themselves, and the model's own account of the goal, what is
   * done and what was learned. If the model cannot write the account the list alone is kept, so nothing is lost silently.
   * Returns null when there is nothing worth summarizing.
   */
  private async compact(
    run: ActiveRun,
    conv: Conversation,
    resolved: ResolvedModel,
    o: { budget: number; tailFraction: number; thinking?: 'on' | 'off'; signal: AbortSignal }
  ): Promise<Compaction | null> {
    const from = keptFrom(conv.messages, conv.compaction)
    const cut = chooseCut(conv.messages, from, Math.max(500, Math.floor(o.budget * o.tailFraction)))
    if (cut <= from) return null
    const range = conv.messages.slice(from, cut)
    if (totalTokens(range) < 300) return null
    const prior = validCompaction(conv.messages, conv.compaction)
    const { entries, calls } = ledgerFrom(range)
    const before = totalTokens(applyCompaction(conv.messages, conv.compaction))

    this.d.emit({ type: 'status', runId: run.runId, conversationId: conv.id, status: 'Summarizing the earlier conversation to free up memory…' })
    const words = Math.max(120, Math.min(380, Math.floor((o.budget * 0.1) / 1.4)))
    const window = resolved.contextTokens ?? Math.max(o.budget + 4000, 8192)
    // A model that thinks first spends part of its reply on that, so it gets room for it on top of the summary.
    const replyTokens = summaryReplyTokens(words, o.thinking, window)
    const capacity = window - replyTokens - 450 - estimateTokens(prior?.narrative ?? '') - 600
    let narrative: string | null = null
    let problem: string | undefined
    const ask = (system: string, user: string, maxTokens: number) =>
      completeTextDetailed(resolved.provider, resolved.option.id, system, user, { maxTokens, temperature: 0.2, signal: o.signal, timeoutMs: 180_000, thinking: o.thinking })
    try {
      narrative = await writeNarrative(
        async (system, user, maxTokens) => {
          let r = await ask(system, user, maxTokens)
          if (!r.text && r.reasoning) {
            // It thought for the whole reply. Ask once more with the per-message switch that turns thinking off (it needs no restart of the server).
            r = await ask(system, `${user}\n\n/no_think`, maxTokens)
            if (!r.text) problem = 'The model used its whole reply thinking and wrote no summary. Set Thinking to Off for this chat, or use a model that does not think.'
          } else if (!r.text) {
            problem = r.finishReason === 'length' ? 'The reply was cut off by the token limit before any text.' : 'The model sent an empty reply.'
          }
          return r.text
        },
        { prior: prior?.narrative ?? '', blocks: transcriptBlocks(range), capacityTokens: capacity, words, replyTokens, onProblem: (why) => (problem ??= why) }
      )
    } catch (e) {
      if (o.signal.aborted || isAbortError(e)) throw e
      narrative = null
      problem = `The model server answered with an error: ${errMsg(e).slice(0, 220)}`
    } finally {
      this.d.emit({ type: 'status', runId: run.runId, conversationId: conv.id, status: '' })
    }

    const next: Compaction = {
      narrative: narrative ?? prior?.narrative ?? '',
      asks: asksFrom(prior?.asks ?? [], range),
      ledger: mergeLedger(prior?.ledger ?? [], entries),
      upToMessageId: conv.messages[cut - 1].id,
      messages: (prior?.messages ?? 0) + range.length,
      toolCalls: (prior?.toolCalls ?? 0) + calls,
      tokensBefore: before,
      tokensAfter: 0,
      createdAt: Date.now(),
      source: narrative ? 'model' : 'ledger',
      narrativeProblem: narrative ? undefined : problem,
      rounds: (prior?.rounds ?? 0) + 1
    }
    next.tokensAfter = totalTokens(applyCompaction(conv.messages, next))
    // A summary that is not smaller than what it replaces would only add work.
    if (next.tokensAfter >= before) return null
    conv.compaction = next
    this.d.conversations.markDirty(conv.id)
    this.d.emit({ type: 'compaction', conversationId: conv.id, compaction: next })
    return next
  }

  private services(run: ActiveRun): ToolServices {
    return {
      imageAvailable: () => this.d.images.available(),
      setPlan: (plan) => {
        run.conv.plan = plan
        this.d.conversations.markDirty(run.conv.id)
        this.d.emit({ type: 'plan', conversationId: run.conv.id, plan })
      },
      addCustomTool: (cfg) => {
        this.d.addCustomTool(cfg)
        run.refreshTools = true
      },
      toolNames: () => this.d.tools.entries(this.d.images.available()).map((e) => e.impl.name),
      codeIndex: (workspace) => this.d.codeIndex.get(workspace),
      generateImage: (args, ctx) =>
        this.d.images.generate(
          {
            prompt: args.prompt,
            negativePrompt: args.negativePrompt ?? (this.d.getSettings().image.negativePrompt || undefined),
            width: args.width ?? 0,
            height: args.height ?? 0,
            steps: args.steps,
            seed: args.seed ?? -1,
            count: args.count ?? 1,
            source: 'chat',
            conversationId: run.conv.id,
            target: run.conv.imageTarget
          },
          { signal: ctx.signal, onProgress: (f, l, stage) => ctx.progress(l, f, stage) }
        )
    }
  }

  private async runTool(run: ActiveRun, toolMap: Map<string, ToolImpl>, tc: ToolCall, workspace: string | null, cutOff = false): Promise<void> {
    const { conv } = run
    const settings = this.d.getSettings()
    const tool = toolMap.get(tc.name)
    const finish = (r: ToolResult & { denied?: boolean }) => {
      const userLimit = toolOutputLimit(settings)
      const memoryLimit = contextOutputLimit(run.budget)
      const limit = Math.min(userLimit, memoryLimit)
      let content = truncateMiddle(r.content ?? '', limit)
      if (memoryLimit < userLimit && content.length < (r.content ?? '').length) {
        content += `\n[Cut to fit the model's memory (${run.budget} tokens). Ask for smaller pieces, e.g. a line range, or raise Context size in Models → Local models.]`
      }
      // After a change to files, remind the model of the step it is on, so it keeps the plan current and does one step at a time.
      if (!r.isError && !r.denied && PLAN_REMINDER_TOOLS.has(tc.name)) {
        const reminder = planReminder(conv.plan)
        if (reminder) content += `\n\n${reminder}`
      }
      const msg: ChatMessage = {
        id: newId('m_'),
        role: 'tool',
        createdAt: Date.now(),
        toolCallId: tc.id,
        toolName: tc.name,
        content,
        isError: r.isError,
        denied: r.denied,
        images: r.images?.length ? r.images : undefined
      }
      this.emitMessage(run, msg)
    }

    if (!tool) {
      finish({
        content: `Unknown tool "${tc.name}". Available tools: ${[...toolMap.keys()].join(', ') || '(none)'}.`,
        isError: true
      })
      return
    }
    // A call that was cut off by the token limit must not be repaired into something shorter: a file written that way is silently incomplete.
    if (cutOff && !isCompleteJson(tc.arguments)) {
      finish({
        content: `This call was cut off because your reply reached the token limit, so it was NOT run (a partial ${tc.name === 'write_file' ? 'file' : 'call'} would have been wrong). Make it smaller: for a large file, create it with just its skeleton and then add each section with edit_file, about 150 to 250 lines per call.`,
        isError: true
      })
      return
    }
    const parsed = parseToolArgs(tc.arguments)
    if (!parsed.ok) {
      finish({ content: `${parsed.error}. Send valid JSON arguments.`, isError: true })
      return
    }
    const args = parsed.value

    const ctx: ToolContext = {
      conversationId: conv.id,
      runId: run.runId,
      toolCallId: tc.id,
      workspace,
      settings,
      signal: run.controller.signal,
      conversation: conv,
      services: this.services(run),
      outputLimit: contextOutputLimit(run.budget),
      progress: (label, fraction, stage) =>
        this.d.emit({ type: 'tool-progress', runId: run.runId, conversationId: conv.id, toolCallId: tc.id, label, progress: fraction, stage })
    }

    // 1. Decide whether to ask the user.
    let preview: ApprovalPreview | undefined
    try {
      preview = await tool.describe?.(args, ctx)
    } catch (e) {
      finish({ content: e instanceof Error ? e.message : String(e), isError: true })
      return
    }
    const permission = this.d.tools.permissionFor(settings, tool)
    let needApproval = permission === 'ask'
    if (preview?.forceApproval) needApproval = true
    if (settings.agent.autoApproveAll) needApproval = false
    if (this.chatAllow.get(conv.id)?.has(tool.name) && !preview?.forceApproval) needApproval = false

    if (needApproval) {
      const request: ApprovalRequest = {
        id: newId('appr_'),
        toolCallId: tc.id,
        toolName: tc.name,
        source: tool.source,
        kind: preview?.kind ?? 'generic',
        title: preview?.title ?? `Run ${tc.name}`,
        path: preview?.path,
        command: preview?.command,
        cwd: preview?.cwd,
        diff: preview?.diff,
        reason: preview?.reason,
        args
      }
      this.d.emit({ type: 'approval', runId: run.runId, conversationId: conv.id, approval: request })
      const decision: ApprovalDecision = await this.d.approvals.request(request, conv.id)
      this.d.emit({ type: 'approval-resolved', runId: run.runId, conversationId: conv.id, approvalId: request.id })
      if (decision === 'deny') {
        finish({
          content: 'The user declined this action. Do not retry the same action; explain what you wanted to do or ask how they would like to proceed.',
          isError: true,
          denied: true
        })
        return
      }
      if (decision === 'allow-chat') {
        const set = this.chatAllow.get(conv.id) ?? new Set<string>()
        set.add(tool.name)
        this.chatAllow.set(conv.id, set)
      } else if (decision === 'always') {
        this.d.setToolPermission(tool.name, 'auto')
      }
    }

    // 2. Run it.
    if (!READ_ONLY_TOOLS.has(tool.name)) run.mapStale = true
    try {
      finish(await tool.execute(args, ctx))
    } catch (e) {
      if (run.controller.signal.aborted) {
        finish({ content: 'Cancelled by the user.', isError: true })
        return
      }
      const message = e instanceof ToolError ? e.message : `Tool failed: ${e instanceof Error ? e.message : String(e)}`
      finish({ content: message, isError: true })
    }
  }

  /* ───────────────────────────── titles ───────────────────────────── */

  private async maybeTitle(conv: Conversation): Promise<void> {
    const settings = this.d.getSettings()
    if (!settings.chat.autoTitle || conv.titleSet) return
    const firstUser = conv.messages.find((m) => m.role === 'user')
    const firstReply = conv.messages.find((m) => m.role === 'assistant' && m.content)
    if (!firstUser || !firstReply) return
    // Only retitle once: when the title is still the provisional first-line title.
    if (conv.messages.filter((m) => m.role === 'user').length > 1) return
    try {
      const resolved = await this.d.models.resolve(conv.modelRef || settings.defaultModel)
      if (!resolved) return
      const raw = await completeText(
        resolved.provider,
        resolved.option.id,
        'You write very short titles for chat conversations. Reply with the title only.',
        `Write a title of at most 5 words for this conversation. No quotes, no trailing punctuation.\n\nUser: ${firstUser.content.slice(0, 500)}\n\nAssistant: ${firstReply.content.slice(0, 500)}`,
        { maxTokens: 32, temperature: 0.3, timeoutMs: 45000 }
      )
      const title = cleanTitle(raw)
      if (title && !conv.titleSet) {
        this.d.conversations.setAutoTitle(conv.id, title)
        this.d.emit({ type: 'title', conversationId: conv.id, title })
        emit('conversations:changed', this.d.conversations.summary(conv))
      }
    } catch {
      /* titles are best-effort */
    }
  }
}
