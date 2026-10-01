import type { ProviderResult } from '../shared/types'

export interface ApApi {
  onUpdate: (cb: (snapshot: ProviderResult[]) => void) => () => void
  refresh: () => Promise<ProviderResult[]>
  get: () => Promise<ProviderResult[]>
  quit: () => Promise<void>
  getOpenAtLogin: () => Promise<boolean>
  setOpenAtLogin: (value: boolean) => Promise<boolean>
}

declare global {
  interface Window {
    ap: ApApi
  }
}

export {}
