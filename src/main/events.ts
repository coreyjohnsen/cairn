import type { EventChannel, IpcEventMap } from '@shared/ipc'

type Sink = <K extends EventChannel>(channel: K, payload: IpcEventMap[K]) => void

let sink: Sink = () => {}
const extra = new Set<Sink>()

/** Wired up by index.ts to forward events to every renderer window. */
export function setEventSink(s: Sink): void {
  sink = s
}

/** Another listener for every event (the companion server forwards them to phones). Returns a way to stop. */
export function addEventSink(s: Sink): () => void {
  extra.add(s)
  return () => extra.delete(s)
}

export function emit<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
  try {
    sink(channel, payload)
  } catch {
    /* window may be gone */
  }
  for (const s of extra) {
    try {
      s(channel, payload)
    } catch {
      /* one listener failing must not stop the others */
    }
  }
}
