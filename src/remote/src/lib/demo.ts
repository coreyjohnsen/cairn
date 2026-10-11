import { installMock } from '@/lib/mock'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useImages } from '@/store/images'
import { useSession } from '../store/session'

/**
 * A browser-only stand-in for the computer, for designing and screenshotting the companion (npm run dev:remote?demo).
 *   ?demo=1       signed in, with the sample chats and pictures
 *   ?demo=pair    the pairing screen
 *   ?demo=notools signed in with picture access off
 */
export async function startDemo(mode: string): Promise<void> {
  installMock()
  if (mode === 'pair') {
    useSession.setState({ phase: 'unpaired' })
    return
  }
  const images = mode !== 'nopictures'
  const session = { device: { id: 'demo', name: 'iPhone · Safari', scopes: { images, tools: mode === 'tools' } }, host: { name: 'DESKTOP-CAIRN', version: '0.9.0' } }
  await useApp.getState().init()
  await Promise.all([useChat.getState().init(), images ? useImages.getState().init() : Promise.resolve()])
  useSession.setState({ phase: 'ready', session, live: true })
}
