import { useEffect, useState } from 'react'

/** True while the screen matches a media query (a tablet-width window, a phone held sideways…). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const change = () => setOn(mq.matches)
    change()
    mq.addEventListener('change', change)
    return () => mq.removeEventListener('change', change)
  }, [query])
  return on
}

/** Tablets and large screens get two panes; phones get one screen at a time. */
export const useWide = (): boolean => useMedia('(min-width: 820px)')

/** A touch screen without a keyboard: Enter should start a new line, not send. */
export const useTouch = (): boolean => useMedia('(pointer: coarse)')

/**
 * Keeps `--app-h` equal to the visible height, so the page shrinks above the on-screen keyboard instead of
 * hiding the message box behind it (iPhone Safari does not do that by itself).
 */
export function useVisibleHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    const set = () => {
      const h = vv?.height ?? window.innerHeight
      document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`)
      // The keyboard can scroll the page itself; the app is fixed to the visible area so nothing is left offset.
      if (vv && vv.offsetTop > 0) window.scrollTo(0, 0)
    }
    set()
    vv?.addEventListener('resize', set)
    vv?.addEventListener('scroll', set)
    window.addEventListener('resize', set)
    return () => {
      vv?.removeEventListener('resize', set)
      vv?.removeEventListener('scroll', set)
      window.removeEventListener('resize', set)
    }
  }, [])
}
