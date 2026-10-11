import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOnce } from '../src/renderer/src/lib/subscribeOnce'

describe('subscribeOnce', () => {
  it('runs the subscription the first time only', () => {
    const run = vi.fn()
    subscribeOnce('t-a', run)
    subscribeOnce('t-a', run)
    subscribeOnce('t-b', run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

// Loaded by path: the node type check must not follow the stores into the browser-only code they import.
const load = (name: string) => import(/* @vite-ignore */ `../src/renderer/src/store/${name}`)

describe('store start-up', () => {
  afterEach(() => vi.unstubAllGlobals())

  // React StrictMode runs the start-up effect twice in development. Every event then reached the stores twice, and each
  // streamed chunk of a reply was added two times ("Quantisation stores each Quantisation stores each weight...").
  it('listens to each event once, even when started twice', async () => {
    const listeners = new Map<string, number>()
    vi.stubGlobal('window', {
      cairn: {
        platform: 'linux',
        invoke: async () => [],
        on: (channel: string) => {
          listeners.set(channel, (listeners.get(channel) ?? 0) + 1)
          return () => {}
        }
      }
    })
    const { useChat } = await load('chat')
    const { useImages } = await load('images')
    const { useRemote } = await load('remote')
    for (const store of [useChat, useImages, useRemote]) {
      await store.getState().init()
      await store.getState().init()
    }
    expect(listeners.get('chat:event')).toBe(1)
    expect(listeners.get('conversations:changed')).toBe(1)
    expect(listeners.get('images:added')).toBe(1)
    expect(listeners.get('remote:status')).toBe(1)
    expect([...listeners.values()].every((n) => n === 1)).toBe(true)
  })
})
