import type { Settings, ThemeId } from '@shared/types'

/**
 * What a phone keeps for itself. The computer's settings are not the phone's to change, but how the page looks
 * (colours, text size) and how typing behaves are personal, so they stay on the phone.
 */

export interface LocalPrefs {
  theme?: ThemeId
  fontScale?: number
  reduceMotion?: boolean
  sendOnEnter?: boolean
}

const THEMES: ThemeId[] = ['alpenglow', 'glacier', 'granite', 'timberline', 'system']

export function cleanPrefs(input: unknown): LocalPrefs {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: LocalPrefs = {}
  if (typeof r.theme === 'string' && THEMES.includes(r.theme as ThemeId)) out.theme = r.theme as ThemeId
  if (typeof r.fontScale === 'number' && r.fontScale >= 0.85 && r.fontScale <= 1.4) out.fontScale = r.fontScale
  if (typeof r.reduceMotion === 'boolean') out.reduceMotion = r.reduceMotion
  if (typeof r.sendOnEnter === 'boolean') out.sendOnEnter = r.sendOnEnter
  return out
}

/** The computer's settings with this phone's own choices on top. */
export function applyPrefs(host: Settings, prefs: LocalPrefs): Settings {
  return {
    ...host,
    appearance: {
      ...host.appearance,
      ...(prefs.theme ? { theme: prefs.theme } : {}),
      ...(prefs.fontScale ? { fontScale: prefs.fontScale } : {}),
      ...(prefs.reduceMotion !== undefined ? { reduceMotion: prefs.reduceMotion } : {})
    },
    chat: { ...host.chat, ...(prefs.sendOnEnter !== undefined ? { sendOnEnter: prefs.sendOnEnter } : {}) }
  }
}

/** The parts of a settings change that belong to the phone; everything else in it is ignored. */
export function prefsFromPatch(patch: Partial<Settings>, prev: LocalPrefs): LocalPrefs {
  const next: Record<string, unknown> = { ...prev }
  if (patch.appearance) {
    if (patch.appearance.theme !== undefined) next.theme = patch.appearance.theme
    if (patch.appearance.fontScale !== undefined) next.fontScale = patch.appearance.fontScale
    if (patch.appearance.reduceMotion !== undefined) next.reduceMotion = patch.appearance.reduceMotion
  }
  if (patch.chat && patch.chat.sendOnEnter !== undefined) next.sendOnEnter = patch.chat.sendOnEnter
  return cleanPrefs(next)
}
