/// <reference types="vite/client" />
import type { CairnApi } from '@shared/ipc'

declare global {
  interface Window {
    cairn: CairnApi
  }
}

export {}
