export type ProviderId = 'chatgpt' | 'claude' | 'cursor' | 'antigravity'

export type ProviderStatus = 'ok' | 'not_found' | 'expired' | 'not_running' | 'error'

export interface UsageWindow {
  label: string
  usedPercent: number
  resetsAt?: string
  /** Full length of this limit window, used to mark how far through the period we are. */
  periodSeconds?: number
  used?: number
  limit?: number
}

export interface ProviderResult {
  id: ProviderId
  status: ProviderStatus
  plan?: string
  windows: UsageWindow[]
  message?: string
  fetchedAt: string
}

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor',
  antigravity: 'Antigravity'
}
