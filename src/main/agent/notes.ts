import fsp from 'node:fs/promises'
import path from 'node:path'

/** The project notes file: what the project is, where things live and how it is done here. Read at the start of every chat in the folder. */
export const NOTES_NAME = 'CAIRN.md'
/** Other names projects already use, read when there is no CAIRN.md. */
const ALSO = ['AGENTS.md', 'CLAUDE.md']
/** The most of the notes the model is shown, so a long file cannot use up its memory. */
export const NOTES_MAX_CHARS = 8000

export interface Notes {
  /** File name relative to the workspace. */
  file: string
  abs: string
  text: string
  /** Shown to the model shortened. */
  cut: boolean
}

export async function readNotes(workspace: string | null): Promise<Notes | null> {
  if (!workspace) return null
  for (const file of [NOTES_NAME, ...ALSO]) {
    const abs = path.join(workspace, file)
    try {
      const text = (await fsp.readFile(abs, 'utf8')).replace(/\r\n/g, '\n')
      if (!text.trim()) continue
      const cut = text.length > NOTES_MAX_CHARS
      return { file, abs, text: cut ? `${text.slice(0, NOTES_MAX_CHARS).trimEnd()}\n[… the rest of ${file} is left out; read the file for it]` : text, cut }
    } catch {
      /* try the next name */
    }
  }
  return null
}

/** The file the notes are written to: an existing notes file, otherwise CAIRN.md. */
export async function notesTarget(workspace: string): Promise<{ file: string; abs: string; existing: string | null }> {
  for (const file of [NOTES_NAME, ...ALSO]) {
    const abs = path.join(workspace, file)
    try {
      return { file, abs, existing: (await fsp.readFile(abs, 'utf8')).replace(/\r\n/g, '\n') }
    } catch {
      /* next */
    }
  }
  return { file: NOTES_NAME, abs: path.join(workspace, NOTES_NAME), existing: null }
}
