import { useId, useMemo } from 'react'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Midpoint-displacement ridge: returns heights in 0..1 for `n + 1` evenly spaced columns. */
export function ridgeHeights(seed: number, n = 96, roughness = 0.55): number[] {
  const rnd = mulberry32(seed)
  // Midpoint displacement needs a power-of-two grid; resample to the requested column count afterwards.
  let size = 2
  while (size < n) size *= 2
  const h = new Array<number>(size + 1).fill(0)
  h[0] = 0.35 + rnd() * 0.3
  h[size] = 0.35 + rnd() * 0.3
  let step = size
  let amp = 0.7
  while (step > 1) {
    const half = step / 2
    for (let i = half; i < size; i += step) {
      h[i] = (h[i - half] + h[i + half]) / 2 + (rnd() - 0.5) * amp
    }
    amp *= roughness
    step = half
  }
  const out = new Array<number>(n + 1)
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * size
    const lo = Math.floor(x)
    const hi = Math.min(size, lo + 1)
    out[i] = h[lo] + (h[hi] - h[lo]) * (x - lo)
  }
  const min = Math.min(...out)
  const max = Math.max(...out)
  return out.map((v) => (v - min) / (max - min || 1))
}

const X0 = -96 // drawn slightly past both edges so the slow drift never reveals a gap
const X1 = 1600 + 96

function xAt(i: number, n: number): number {
  return X0 + (i / n) * (X1 - X0)
}

function pathFor(heights: number[], h: number, floor: number, ceil: number): string {
  const n = heights.length - 1
  let d = `M${X0},${h}`
  for (let i = 0; i <= n; i++) {
    const y = h - (floor + heights[i] * (ceil - floor)) * h
    d += ` L${xAt(i, n).toFixed(1)},${y.toFixed(1)}`
  }
  return `${d} L${X1},${h} Z`
}

interface Props {
  seed?: number
  className?: string
  /** 1–4 layers, far to near. */
  layers?: number
  /** Draw a sun/moon glow behind the peaks. */
  glow?: boolean
  /** Slow parallax drift. */
  animate?: boolean
  /** Fade the near edge into the background colour. */
  fade?: boolean
}

/** Procedural layered mountain silhouettes, coloured by the current theme. */
export function Ridgeline({ seed = 7, className, layers = 4, glow = true, animate = false, fade = true }: Props) {
  const W = 1600
  const H = 360
  const paths = useMemo(() => {
    const out: { d: string; snow: string | null; top: number }[] = []
    for (let i = 0; i < layers; i++) {
      const heights = ridgeHeights(seed * 31 + i * 17, 120, 0.56 - i * 0.02)
      const floor = 0.1 + i * 0.05
      const ceil = 0.78 - i * 0.12
      const d = pathFor(heights, H, floor, ceil)
      const snow: string | null = i < 2 ? d : null
      out.push({ d, snow, top: H - ceil * H })
    }
    return out
  }, [seed, layers])

  const id = `rl-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-glow`} cx="68%" cy="62%" r="55%">
          <stop offset="0%" style={{ stopColor: 'var(--glow)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--glow)', stopOpacity: 0 }} />
        </radialGradient>
        {paths.map((p, i) =>
          p.snow ? (
            <linearGradient key={i} id={`${id}-snow-${i}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={p.top} y2={p.top + H * 0.2}>
              <stop offset="0" style={{ stopColor: 'var(--snow)' }} />
              <stop offset="0.4" style={{ stopColor: 'var(--snow)' }} />
              <stop offset="1" style={{ stopColor: 'var(--snow)', stopOpacity: 0 }} />
            </linearGradient>
          ) : null
        )}
        {fade && (
          <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.62" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
        )}
        {fade && (
          <mask id={`${id}-mask`} maskContentUnits="userSpaceOnUse">
            <rect width={W} height={H} fill={`url(#${id}-fade)`} />
          </mask>
        )}
      </defs>
      {glow && <rect width={W} height={H} fill={`url(#${id}-glow)`} />}
      {/* The mask stays put on the outer group; only the inner group drifts, or the mask's edge would slide into view. */}
      <g mask={fade ? `url(#${id}-mask)` : undefined}>
        <g className={animate ? 'ridge-drift' : undefined}>
          {paths.map((p, i) => (
            <g key={i}>
              <path d={p.d} style={{ fill: `var(--ridge-${i + 1 + (4 - layers)})` }} />
              {p.snow && <path d={p.snow} fill={`url(#${id}-snow-${i})`} />}
            </g>
          ))}
        </g>
      </g>
    </svg>
  )
}
