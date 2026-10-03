import type { EventChannel, IpcEventMap } from '@shared/ipc'

type Sink = <K extends EventChannel>(channel: K, payload: IpcEventMap[K]) => void

let sink: Sink = () => {}

/** Wired up by index.ts to forward events to every renderer window. */
export function setEventSink(s: Sink): void {
  sink = s
}

export function emit<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
  try {
    sink(channel, payload)
  } catch {
    /* window may be gone */
  }
}
