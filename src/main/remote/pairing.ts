import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PAIR_ALPHABET, PAIR_CODE_LENGTH, normalizePairCode } from '@shared/remotePrefs'

/**
 * The one-time code that pairs a phone. It lives only in memory, works once, runs out after a few minutes, and the
 * server locks out anyone who keeps guessing: both per address and for the code as a whole.
 */

export const PAIR_TTL_MS = 5 * 60_000
/** Wrong guesses one address may make before it is paused. */
const CLIENT_FAILS = 5
/** Wrong guesses of any kind after which the code is thrown away and a new one is needed. */
const OFFER_FAILS = 15
const LOCK_MS = 60_000
const MAX_CLIENTS = 500

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  | { ok: false; reason: 'none' | 'expired' | 'invalid' }

export interface PairingDeps {
  now?: () => number
  random?: (n: number) => Uint8Array
  ttlMs?: number
}

interface Offer {
  code: string
  expiresAt: number
  failures: number
}

/** A random code from the alphabet, without bias (bytes that would favour some symbols are skipped). */
export function randomPairCode(random: (n: number) => Uint8Array = randomBytes): string {
  const limit = 256 - (256 % PAIR_ALPHABET.length)
  let out = ''
  while (out.length < PAIR_CODE_LENGTH) {
    for (const b of random(PAIR_CODE_LENGTH * 2)) {
      if (b < limit) out += PAIR_ALPHABET[b % PAIR_ALPHABET.length]
      if (out.length === PAIR_CODE_LENGTH) break
    }
  }
  return out
}

export class PairingBook {
  private offer: Offer | null = null
  private clients = new Map<string, { fails: number; until: number }>()
  private now: () => number
  private random: (n: number) => Uint8Array
  private ttl: number

  constructor(deps: PairingDeps = {}) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? randomBytes
    this.ttl = deps.ttlMs ?? PAIR_TTL_MS
  }

  /** Starts a new offer; any earlier one stops working. */
  create(): { code: string; expiresAt: number } {
    this.offer = { code: randomPairCode(this.random), expiresAt: this.now() + this.ttl, failures: 0 }
    return { code: this.offer.code, expiresAt: this.offer.expiresAt }
  }

  cancel(): void {
    this.offer = null
  }

  /** The offer people can use right now, if there is one. */
  active(): { code: string; expiresAt: number } | null {
    const o = this.offer
    if (!o) return null
    if (o.expiresAt <= this.now()) {
      this.offer = null
      return null
    }
    return { code: o.code, expiresAt: o.expiresAt }
  }

  /** Checks a code from one client (its network address). A right code is used up. */
  redeem(input: unknown, client: string): RedeemResult {
    const now = this.now()
    const c = this.clients.get(client)
    if (c && c.until > now) return { ok: false, reason: 'locked', retryAfterMs: c.until - now }

    const offer = this.active()
    if (!offer) {
      // Guessing with no code open still counts, so a stranger cannot probe for the moment one appears.
      this.fail(client)
      return { ok: false, reason: this.offer === null ? 'none' : 'expired' }
    }
    const given = normalizePairCode(input)
    const a = Buffer.from(given ?? '?'.repeat(PAIR_CODE_LENGTH))
    const b = Buffer.from(offer.code)
    if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
      this.fail(client)
      if (this.offer && ++this.offer.failures >= OFFER_FAILS) this.offer = null
      return { ok: false, reason: 'invalid' }
    }
    this.offer = null
    this.clients.delete(client)
    return { ok: true }
  }

  private fail(client: string): void {
    const now = this.now()
    if (this.clients.size >= MAX_CLIENTS) {
      for (const [k, v] of this.clients) if (v.until <= now && v.fails < CLIENT_FAILS) this.clients.delete(k)
      if (this.clients.size >= MAX_CLIENTS) this.clients.clear()
    }
    const c = this.clients.get(client) ?? { fails: 0, until: 0 }
    c.fails += 1
    if (c.fails >= CLIENT_FAILS) {
      // Every further burst of wrong guesses waits longer, up to about 15 minutes.
      const rounds = Math.floor(c.fails / CLIENT_FAILS)
      c.until = now + LOCK_MS * Math.min(15, 2 ** (rounds - 1))
    }
    this.clients.set(client, c)
  }
}
