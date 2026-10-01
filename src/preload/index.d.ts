import type { ProviderResult } from '../shared/types'

export interface ApApi {
  onUpdate: (cb: (snapshot: ProviderResult[]) => void) => () => void
  refresh: () => Promise<ProviderResult[]>
  get: () => Promise<ProviderResult[]>
  setPopupHeight: (height: number) => void
}

declare global {
  interface Window {
    ap: ApApi
  }
}

export {}
