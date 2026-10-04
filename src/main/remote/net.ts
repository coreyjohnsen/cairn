import os from 'node:os'
import type { RemoteAddress } from '@shared/types'
import { normalizePublicUrl } from '@shared/remotePrefs'

/** Network helpers for the companion: which addresses a phone can reach this computer on. */

type Interfaces = ReturnType<typeof os.networkInterfaces>

/** Adapters that only exist inside this computer (containers, virtual machines); a phone cannot reach them. */
const VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|vethernet|wsl|podman|cni|flannel|kube|tun|tap)/i

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((p) => p <= 255) ? parts : null
}

/** 'tailscale' for the carrier-grade range Tailscale hands out (100.64.0.0/10), 'lan' for private and ordinary addresses, null for ones no phone can use. */
export function classifyAddress(ip: string): RemoteAddress['kind'] | null {
  const p = parseV4(ip)
  if (!p) return null
  const [a, b] = p
  if (a === 127 || a === 0) return null
  if (a === 169 && b === 254) return null // link-local: no router handed it out
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  return 'lan'
}

/** Private-network addresses first: a phone at home reaches those; a public one is a last resort. */
function privateRank(ip: string): number {
  const p = parseV4(ip)!
  if (p[0] === 192 && p[1] === 168) return 0
  if (p[0] === 10) return 1
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 2
  return 3
}

/** The pages a phone can open to reach the companion, best first: your own address, Tailscale, then the home network. */
export function remoteAddresses(port: number, publicUrl = '', interfaces: Interfaces = os.networkInterfaces()): RemoteAddress[] {
  const out: RemoteAddress[] = []
  const custom = normalizePublicUrl(publicUrl)
  if (custom) out.push({ label: 'Your address', url: custom, kind: 'custom' })

  const found: { ip: string; kind: 'lan' | 'tailscale'; name: string }[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const kind = classifyAddress(a.address)
      if (!kind) continue
      if (kind === 'lan' && VIRTUAL.test(name)) continue
      found.push({ ip: a.address, kind: kind === 'tailscale' ? 'tailscale' : 'lan', name })
    }
  }
  const ts = found.filter((f) => f.kind === 'tailscale')
  const lan = found.filter((f) => f.kind === 'lan').sort((a, b) => privateRank(a.ip) - privateRank(b.ip))
  for (const f of ts) out.push({ label: 'Tailscale · anywhere', url: `http://${f.ip}:${port}`, kind: 'tailscale' })
  for (const f of lan) out.push({ label: lan.length > 1 ? `Same Wi-Fi · ${f.name}` : 'Same Wi-Fi', url: `http://${f.ip}:${port}`, kind: 'lan' })
  return out
}

/** The client's address as the server saw it, without the IPv6 wrapper around an IPv4 one. */
export function clientAddress(remote: string | undefined): string {
  const a = (remote ?? '').replace(/^::ffff:/i, '')
  return a || 'unknown'
}
