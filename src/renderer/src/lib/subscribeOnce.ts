const started = new Set<string>()

/**
 * Runs `subscribe` the first time it is called for `key`, and does nothing after that. Start-up can run more than once
 * (in development React StrictMode runs effects twice), and a second set of listeners would apply every event twice:
 * each streamed chunk of a reply would appear two times until the finished message replaced it.
 */
export function subscribeOnce(key: string, subscribe: () => void): void {
  if (started.has(key)) return
  started.add(key)
  subscribe()
}
