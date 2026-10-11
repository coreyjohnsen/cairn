/**
 * Notices when the assistant fails in the same way again, which usually means it is guessing at something it could look up
 * (a file's real contents, a module's real functions). The second identical failure gets a nudge to stop and look.
 */
export class FailureTracker {
  private seen = new Map<string, number>()

  /** The same failure counts again only when it comes back in a row; anything that works in between clears the slate. */
  reset(): void {
    this.seen.clear()
  }

  /** A short signature of a failure: the same file or tool and the same first line of the message. */
  static key(tool: string, subject: string, message: string): string {
    const first = message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('[')) ?? ''
    return `${tool}|${subject}|${first.replace(/\d+/g, '#').slice(0, 120)}`
  }

  /** Record a failure; returns advice once it has happened twice (and again at each further repeat). */
  failed(key: string): string {
    const n = (this.seen.get(key) ?? 0) + 1
    this.seen.set(key, n)
    if (n < 2) return ''
    return `[This is the ${n === 2 ? 'second' : `${n}th`} time the same thing failed. Stop trying variations of the same fix. Look at the real thing first: read the file again (read_file) or list what a module really offers (file_outline, find_symbol), then change it once, correctly. If you cannot tell what is wrong, tell the user what you tried.]`
  }

  /** Something worked for this tool and subject, so a later failure is a new one, not "again". `prefix` is the start of the keys. */
  succeeded(prefix: string): void {
    for (const k of [...this.seen.keys()]) if (k.startsWith(prefix)) this.seen.delete(k)
  }
}
