/// <reference types="vite/client" />

import type { AppApi } from '../../preload'

declare global {
  interface Window {
    api: AppApi
    MonacoEnvironment: {
      getWorker(_moduleId: string, _label: string): Worker
    }
  }
}
