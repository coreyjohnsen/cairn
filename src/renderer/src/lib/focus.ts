import type { ImageJob, ImageRecord } from '@shared/types'

/** What the Image Hub's big view shows: a finished picture, or a job that is still being made (or failed). */
export type FocusItem = { kind: 'record'; rec: ImageRecord } | { kind: 'job'; job: ImageJob }

export const jobKey = (id: string): string => `job:${id}`

/**
 * What the big view should show: the thing the person picked, or failing that the newest. A job that has finished
 * turns into its newest picture by itself, so starting a picture ends with it filling the stage.
 */
export function resolveFocus(focus: string | null, records: ImageRecord[], jobs: Record<string, ImageJob>, fallbackKey: string | undefined): FocusItem | null {
  const tryKey = (key: string | null | undefined): FocusItem | null => {
    if (!key) return null
    if (key.startsWith('job:')) {
      const job = jobs[key.slice(4)]
      if (!job || job.status === 'cancelled') return null
      if (job.status === 'done') {
        // The newest picture of a batch sits first in the history, so that is the one to land on.
        const rec = [...job.resultIds].reverse().map((id) => records.find((r) => r.id === id)).find(Boolean)
        // The job report can arrive a moment before the picture itself.
        return rec ? { kind: 'record', rec } : { kind: 'job', job }
      }
      return { kind: 'job', job }
    }
    const rec = records.find((r) => r.id === key)
    return rec ? { kind: 'record', rec } : null
  }
  return tryKey(focus) ?? tryKey(fallbackKey)
}
