import { Cpu, MemoryStick, RotateCcw } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { MemoryHardware, ModelRuntimeOverride, ModelShape } from '@shared/types'
import { CONTEXT_STEPS, type KvType, type LadderRow, type Plan, contextLadder, evaluate, formatGB, longestOnGpu, recommend, settingsFor } from '@shared/memoryPlan'
import { runtimeFor } from '@shared/runtimePrefs'
import { Badge, Button, Card, Field, Select, Spinner } from '@/components/ui'
import { invoke } from '@/lib/api'
import { cx, errorText, formatBytes } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'

const KV_OPTIONS: { value: KvType; label: string }[] = [
  { value: 'f16', label: 'Full (16-bit)' },
  { value: 'q8_0', label: '8-bit: half the memory' },
  { value: 'q4_0', label: '4-bit: a quarter, some loss' }
]

/** Speeds people can pick when the computer cannot tell (GB/s that a model run really gets). */
const RAM_CHOICES = [
  { value: 18, label: 'One stick or single channel (about 18 GB/s)' },
  { value: 36, label: 'Dual-channel DDR4-3200 (about 36 GB/s)' },
  { value: 63, label: 'Dual-channel DDR5-5600 (about 63 GB/s)' },
  { value: 100, label: 'Four channels or very fast DDR5 (about 100 GB/s)' }
]

const tone = (p: Plan): 'ok' | 'info' | 'warn' | 'danger' => (p.verdict === 'gpu' ? 'ok' : p.verdict === 'too-big' ? 'danger' : p.verdict === 'cpu' ? 'warn' : 'info')
const speedWords = { smooth: 'smooth', fine: 'fine to read along', slow: 'slow', crawl: 'very slow' } as const
const rate = (n: number): string => (n >= 10 ? String(Math.round(n)) : n.toFixed(1))

/** Short label for one cell of the "what fits" table. */
function cellLabel(p: Plan, layers: number): string {
  if (!p.fits) return 'does not fit'
  if (p.verdict === 'gpu') return 'on the GPU'
  if (p.verdict === 'experts') return 'experts in RAM'
  if (p.verdict === 'cpu') return 'CPU only'
  return p.choice.kvInRam && p.estimate.layersOnGpu === layers ? 'cache in RAM' : `${p.estimate.layersOnGpu}/${layers} on GPU`
}

function Meter({ label, parts, used, budget }: { label: string; parts: { name: string; bytes: number; cls: string }[]; used: number; budget: number }) {
  const scale = Math.max(budget, used, 1)
  const over = used > budget
  return (
    <div className="mp-meter">
      <div className="mp-meter-head">
        <span>{label}</span>
        <span className={cx('mono xs', over ? 'mp-over' : 'dim')}>
          {formatGB(used)} of {formatGB(Math.max(0, budget))} usable
        </span>
      </div>
      <div className="mp-bar" role="img" aria-label={`${label}: ${formatGB(used)} of ${formatGB(Math.max(0, budget))}`}>
        {parts.map((p) =>
          p.bytes > 0 ? <span key={p.name} className={cx('mp-seg', p.cls)} style={{ width: `${(p.bytes / scale) * 100}%` }} title={`${p.name}: ${formatGB(p.bytes)}`} /> : null
        )}
        <span className="mp-limit" style={{ left: `${(Math.max(0, budget) / scale) * 100}%` }} />
      </div>
      <div className="mp-legend">
        {parts
          .filter((p) => p.bytes > 0)
          .map((p) => (
            <span key={p.name}>
              <i className={cx('mp-dot', p.cls)} />
              {p.name} {formatGB(p.bytes)}
            </span>
          ))}
      </div>
    </div>
  )
}

function LadderTable({ rows, shape, ctx, kv, onPick }: { rows: Record<KvType, LadderRow[]>; shape: ModelShape; ctx: number; kv: KvType; onPick: (ctx: number, kv: KvType) => void }) {
  const kinds: KvType[] = ['f16', 'q8_0', 'q4_0']
  const sizes = rows.f16.map((r) => r.contextSize)
  return (
    <div className="mp-ladder" role="table" aria-label="What fits at each context length">
      <div className="mp-ladder-row head" role="row">
        <span role="columnheader">Context</span>
        {kinds.map((k) => (
          <span key={k} role="columnheader">
            {k === 'f16' ? 'Full precision' : k === 'q8_0' ? '8-bit' : '4-bit'}
          </span>
        ))}
      </div>
      {sizes.map((size, i) => (
        <div key={size} className="mp-ladder-row" role="row">
          <span className="mono small" role="rowheader">
            {size.toLocaleString()}
          </span>
          {kinds.map((k) => {
            const p = rows[k][i].plan
            const on = size === ctx && k === kv
            return (
              <button key={k} type="button" role="cell" className={cx('mp-cell', `t-${tone(p)}`, on && 'on')} onClick={() => onPick(size, k)} title={p.headline}>
                <span>{cellLabel(p, shape.layers)}</span>
                {p.fits && <span className="xs dim">~{rate(p.speed.tokensPerSecond)} tok/s</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function summary(o: ModelRuntimeOverride | undefined): string {
  if (!o) return ''
  const bits: string[] = []
  if (o.contextSize) bits.push(`${o.contextSize.toLocaleString()} tokens`)
  if (o.gpuLayers !== undefined) bits.push(o.gpuLayers < 0 ? 'all layers on the GPU' : o.gpuLayers === 0 ? 'CPU only' : `${o.gpuLayers} layers on the GPU`)
  if (o.nCpuMoe) bits.push(`experts of ${o.nCpuMoe} layers in RAM`)
  if (o.kvInRam) bits.push('working memory in RAM')
  if (o.kvCache && o.kvCache !== 'f16') bits.push(o.kvCache === 'q8_0' ? '8-bit memory' : '4-bit memory')
  return bits.join(', ')
}
export { summary as describeOverride }

export function MemoryPlanner() {
  const gguf = useLibrary((s) => s.gguf)
  const llama = useLibrary((s) => s.llama)
  const local = useApp((s) => s.settings!.local)
  const update = useApp((s) => s.update)
  const toast = useApp((s) => s.toast)
  const [path, setPath] = useState('')
  const [hw, setHw] = useState<MemoryHardware | null>(null)
  const [hwErr, setHwErr] = useState('')
  const [shape, setShape] = useState<ModelShape | null>(null)
  const [shapeErr, setShapeErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [ctx, setCtx] = useState(8192)
  const [kv, setKv] = useState<KvType>('f16')
  const [ramSpeed, setRamSpeed] = useState(0)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    invoke('memory:hardware')
      .then(setHw)
      .catch((e) => setHwErr(errorText(e)))
  }, [])

  // Start on the model that is loaded, or was last used, or the first one.
  useEffect(() => {
    if (path && gguf.some((g) => g.path === path)) return
    const pick = (llama.modelPath && gguf.find((g) => g.path === llama.modelPath)) || gguf.find((g) => g.path === local.lastModelPath) || gguf[0]
    setPath(pick?.path ?? '')
  }, [gguf, path, llama.modelPath, local.lastModelPath])

  useEffect(() => {
    if (!path) return
    let stale = false
    setLoading(true)
    setShapeErr('')
    invoke('memory:inspect', path)
      .then((s) => {
        if (stale) return
        setShape(s)
        const rt = runtimeFor(useApp.getState().settings!.local, path)
        setCtx(rt.contextSize)
        setKv(rt.kvCache ?? 'f16')
      })
      .catch((e) => {
        if (stale) return
        setShape(null)
        setShapeErr(errorText(e))
      })
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [path])

  const flash = local.flashAttn !== 'off'
  const used = useMemo(() => (hw && ramSpeed ? { ...hw, ramBandwidthGBs: ramSpeed } : hw), [hw, ramSpeed])
  const plan = useMemo(() => (shape && used ? recommend(shape, used, { contextSize: ctx, kvCache: kv, flashAttn: flash }) : null), [shape, used, ctx, kv, flash])
  const ladder = useMemo(() => {
    if (!shape || !used) return null
    return { f16: contextLadder(shape, used, 'f16', flash), q8_0: contextLadder(shape, used, 'q8_0', flash), q4_0: contextLadder(shape, used, 'q4_0', flash) }
  }, [shape, used, flash])
  const rt = runtimeFor(local, path)
  const current = useMemo(
    () => (shape && used ? evaluate(shape, used, { contextSize: rt.contextSize, gpuLayers: rt.gpuLayers, nCpuMoe: rt.nCpuMoe ?? 0, kvInRam: !!rt.kvInRam, kvCache: rt.kvCache ?? 'f16', flashAttn: flash }) : null),
    [shape, used, rt.contextSize, rt.gpuLayers, rt.nCpuMoe, rt.kvInRam, rt.kvCache, flash]
  )

  const file = gguf.find((g) => g.path === path)
  const saved = local.modelOverrides?.[path]
  const wanted = plan ? settingsFor(plan) : null
  const sameAsSaved = !!(saved && wanted && saved.contextSize === wanted.contextSize && saved.gpuLayers === wanted.gpuLayers && (saved.nCpuMoe ?? 0) === wanted.nCpuMoe && !!saved.kvInRam === wanted.kvInRam && (saved.kvCache ?? 'f16') === wanted.kvCache)
  const loadedHere = llama.modelPath === path && (llama.state === 'running' || llama.state === 'starting')

  const apply = () => {
    if (!wanted || !path) return
    update((s) => ({ local: { ...s.local, modelOverrides: { ...s.local.modelOverrides, [path]: wanted } } }))
    toast('ok', `Saved for ${file?.label ?? file?.name ?? 'this model'}. It takes effect the next time the model loads.`)
  }
  const clear = () => {
    update((s) => {
      const { [path]: _gone, ...rest } = s.local.modelOverrides ?? {}
      return { local: { ...s.local, modelOverrides: rest } }
    })
    if (shape) {
      const g = runtimeFor({ ...local, modelOverrides: {} }, path)
      setCtx(g.contextSize)
      setKv(g.kvCache ?? 'f16')
    }
  }
  const reload = async () => {
    setReloading(true)
    try {
      await invoke('llama:start', path)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setReloading(false)
    }
  }

  if (!gguf.length) return <div className="faint small">Add a model first. The planner shows what fits once there is one on this computer.</div>

  const flagWarning =
    plan && hw && plan.estimate.expertLayersInRam > 0 && hw.flags.known && !hw.flags.nCpuMoe && !hw.flags.overrideTensor
      ? 'The installed llama.cpp is too old to keep experts in RAM. Update it under Models, Engines.'
      : plan && hw && plan.choice.kvInRam && hw.flags.known && !hw.flags.noKvOffload
        ? 'The installed llama.cpp cannot keep the working memory in RAM. Update it under Models, Engines.'
        : plan && hw && !hw.flags.known && plan.verdict !== 'gpu'
          ? 'Install the engine (Models, Engines) before applying: it decides which of these options your copy supports.'
          : ''

  const report = loadedHere ? llama.memory : undefined
  const sizeLabel = (m: { sizeBytes: number }) => formatBytes(m.sizeBytes)

  let body: ReactNode = null
  if (loading || (!hw && !hwErr)) {
    body = (
      <div className="row dim">
        <Spinner size={15} /> <span>Reading the model…</span>
      </div>
    )
  } else if (hwErr) body = <div className="dl-err selectable">{hwErr}</div>
  else if (shapeErr) body = <div className="dl-err selectable">{shapeErr}</div>
  else if (shape && hw && used && plan && ladder && current) {
    const e = plan.estimate
    const onGpu = longestOnGpu(ladder.f16)
    const onGpu8 = longestOnGpu(ladder.q8_0)
    const trained = shape.trainedContext
    body = (
      <>
        <div className="mp-hw">
          <span>
            <Cpu size={14} /> {hw.gpuName ? `${hw.gpuName} · ${formatGB(hw.vramMB * 1048576)} video memory` : 'No dedicated GPU found'}
          </span>
          <span>
            <MemoryStick size={14} /> {formatGB(hw.ramMB * 1048576)} RAM{hw.ramDetected ? ` (${hw.ramDetail})` : ''}
          </span>
        </div>
        {!hw.ramDetected && (
          <Field row label="RAM speed" hint="Cairn cannot read this on your system, so it assumes ordinary dual-channel DDR4. Only the speed estimates depend on it.">
            <Select value={ramSpeed} onChange={setRamSpeed} options={[{ value: 0, label: `Assume ${hw.ramDetail}` }, ...RAM_CHOICES]} />
          </Field>
        )}
        {hw.vramMB > 0 && !hw.gpuBandwidthKnown && <p className="xs faint">The speed of this graphics card is not in Cairn’s list, so the estimated speeds are a guess.</p>}

        <div className="mp-controls">
          <Field label="Context size" hint={trained ? `This model was trained for up to ${trained.toLocaleString()} tokens.` : undefined}>
            <Select
              value={ctx}
              onChange={setCtx}
              options={[...new Set([...CONTEXT_STEPS.filter((c) => !trained || c <= Math.max(trained, 8192)), ctx])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${n.toLocaleString()} tokens` }))}
            />
          </Field>
          <Field label="Memory precision" hint={flash ? 'How the working memory is stored.' : 'Flash attention is off, so full precision is used.'}>
            <Select value={kv} onChange={setKv} options={KV_OPTIONS} disabled={!flash} />
          </Field>
        </div>

        <div className={cx('mp-verdict', `t-${tone(plan)}`)} role="status">
          <div className="mp-headline">{plan.headline}</div>
          <div className="mp-speed">
            {plan.fits ? (
              <>
                About <b>{rate(plan.speed.tokensPerSecond)} tokens/s</b> ({speedWords[plan.speed.label]}) once it has loaded. <span className="faint">A rough estimate.</span>
              </>
            ) : (
              <>Lower the context size, use 8-bit memory, or pick a smaller quantisation.</>
            )}
          </div>
        </div>

        <div className="mp-meters">
          {hw.vramMB > 0 && (
            <Meter
              label="Video memory"
              used={e.gpu.total}
              budget={e.vramBudget}
              parts={[
                { name: 'model', bytes: e.gpu.weights + e.gpu.picture, cls: 'a' },
                { name: 'working memory', bytes: e.gpu.cache, cls: 'b' },
                { name: 'scratch', bytes: e.gpu.compute + e.gpu.overhead, cls: 'c' }
              ]}
            />
          )}
          <Meter
            label="RAM"
            used={e.cpu.total}
            budget={e.ramBudget}
            parts={[
              { name: 'model', bytes: e.cpu.weights, cls: 'a' },
              { name: 'working memory', bytes: e.cpu.cache, cls: 'b' },
              { name: 'scratch', bytes: e.cpu.compute, cls: 'c' }
            ]}
          />
        </div>

        {[...plan.warnings, flagWarning].filter(Boolean).map((w) => (
          <p key={w} className="mp-warn small">
            {w}
          </p>
        ))}

        <div className="mp-actions">
          <Button variant="primary" onClick={apply} disabled={!plan.fits || sameAsSaved}>
            {sameAsSaved ? 'Saved for this model' : 'Use this for this model'}
          </Button>
          {saved && (
            <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={clear}>
              Back to the general settings
            </Button>
          )}
          {loadedHere && sameAsSaved && (
            <Button variant="soft" busy={reloading} onClick={() => void reload()}>
              Reload with these settings
            </Button>
          )}
        </div>
        {saved && (
          <p className="xs faint">
            Saved for this model: {summary(saved)}. {loadedHere && llama.memory ? '' : 'Other models keep using the general settings under Runtime.'}
          </p>
        )}

        <div className="mp-sub">
          <h4>What fits</h4>
          <p className="xs faint">
            Pick any cell to try it. {onGpu8 > onGpu ? `At full speed (all on the GPU) this model reaches ${onGpu ? onGpu.toLocaleString() : 'less than the smallest size'} tokens at full precision and ${onGpu8.toLocaleString()} with 8-bit memory.` : onGpu ? `All on the GPU, this model reaches ${onGpu.toLocaleString()} tokens.` : 'Nothing here fits entirely on the GPU; the table shows what RAM can do.'}
          </p>
          <LadderTable rows={ladder} shape={shape} ctx={ctx} kv={kv} onPick={(c, k) => (setCtx(c), setKv(k))} />
        </div>

        {(!current.fits || saved || rt !== local) && (
          <p className={cx('small', current.fits ? 'faint' : 'mp-warn')}>
            With the settings this model runs with now ({summary({ contextSize: rt.contextSize, gpuLayers: rt.gpuLayers, nCpuMoe: rt.nCpuMoe, kvInRam: rt.kvInRam, kvCache: rt.kvCache })}): {current.headline}
          </p>
        )}

        {loadedHere && (report || llama.speed) && (
          <div className="mp-report">
            <h4>What the engine reports</h4>
            {report && (
              <p className="small">
                Model {formatGB(report.gpuModelMB * 1048576)} in video memory
                {report.cpuModelMB ? `, ${formatGB(report.cpuModelMB * 1048576)} in RAM` : ''}; working memory {formatGB((report.gpuCacheMB + report.cpuCacheMB) * 1048576)}
                {report.cpuCacheMB ? ` (${formatGB(report.cpuCacheMB * 1048576)} in RAM)` : ''}; scratch {formatGB((report.gpuComputeMB + report.cpuComputeMB) * 1048576)}.
                {report.layersTotal ? ` ${report.layersOnGpu} of ${report.layersTotal} layers on the GPU.` : ''}
              </p>
            )}
            {llama.speed && (
              <p className="small">
                Last answer: {llama.speed.generation ? `${rate(llama.speed.generation)} tokens/s writing` : ''}
                {llama.speed.generation && llama.speed.prompt ? ', ' : ''}
                {llama.speed.prompt ? `${rate(llama.speed.prompt)} tokens/s reading the prompt` : ''}.
              </p>
            )}
          </div>
        )}
      </>
    )
  }

  return (
    <Card>
      <div className="mp">
        <Field label="Model">
          <Select value={path} onChange={setPath} options={gguf.map((g) => ({ value: g.path, label: `${g.label ?? g.name} · ${sizeLabel(g)}${local.modelOverrides?.[g.path] ? ' · planned' : ''}` }))} />
        </Field>
        {shape && !loading && (
          <div className="mp-facts xs faint">
            {shape.layers} layers{shape.experts ? ` · ${shape.experts} experts, ${shape.expertsUsed} used per word` : ''}
            {shape.slidingWindow && shape.swaLayers ? ' · sliding-window attention' : ''} · {formatBytes(shape.fileBytes)} file
            {shape.mmprojBytes ? ' · reads pictures' : ''}
          </div>
        )}
        {body}
      </div>
    </Card>
  )
}

export function PlannedBadge({ path }: { path: string }) {
  const o = useApp((s) => s.settings!.local.modelOverrides?.[path])
  if (!o) return null
  return (
    <Badge tone="accent" title={`Set up by the memory planner: ${summary(o)}`}>
      planned
    </Badge>
  )
}
