type Op = { t: ' ' | '+' | '-'; line: string }

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((line) => ({ t: '+', line }))
  if (m === 0) return a.map((line) => ({ t: '-', line }))
  if (n * m > 4_000_000) {
    return [...a.map((line): Op => ({ t: '-', line })), ...b.map((line): Op => ({ t: '+', line }))]
  }
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: '-', line: a[i++] })
    } else {
      ops.push({ t: '+', line: b[j++] })
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] })
  while (j < m) ops.push({ t: '+', line: b[j++] })
  return ops
}

/**
 * Compact line diff for approval dialogs. Lines are prefixed with ' ', '+' or '-'; hunks are
 * separated by "@@ line N @@" markers.
 */
export function makeDiff(before: string, after: string, context = 3, maxLines = 400): string {
  const A = before.split('\n')
  const B = after.split('\n')
  let s = 0
  while (s < A.length && s < B.length && A[s] === B[s]) s++
  let ea = A.length
  let eb = B.length
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea--
    eb--
  }
  const ops: Op[] = [
    ...A.slice(0, s).map((line): Op => ({ t: ' ', line })),
    ...lcsOps(A.slice(s, ea), B.slice(s, eb)),
    ...A.slice(ea).map((line): Op => ({ t: ' ', line }))
  ]

  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t !== ' ') {
      for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true
    }
  }
  if (!keep.some(Boolean)) return '(no changes)'

  const out: string[] = []
  let oldLine = 0
  let newLine = 0
  let inGap = false
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.t !== '+') oldLine++
    if (op.t !== '-') newLine++
    if (!keep[i]) {
      inGap = true
      continue
    }
    if (inGap || (out.length === 0 && i > 0)) {
      out.push(`@@ line ${Math.max(oldLine, 1)} @@`)
      inGap = false
    }
    out.push(op.t + op.line)
    if (out.length >= maxLines) {
      out.push('… (diff truncated)')
      break
    }
  }
  return out.join('\n')
}

export function previewNewFile(content: string, maxLines = 60): string {
  const lines = content.split('\n')
  const shown = lines.slice(0, maxLines).map((l) => `+${l}`)
  if (lines.length > maxLines) shown.push(`… (${lines.length - maxLines} more lines)`)
  return shown.join('\n')
}
