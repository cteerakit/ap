import { fetchChatGPT } from './chatgpt'
import { fetchClaude } from './claude'
import { fetchCursor } from './cursor'
import { fetchAntigravity } from './antigravity'
import { result, type ProviderId, type ProviderResult } from './types'

export const PROVIDERS: { id: ProviderId; fetch: () => Promise<ProviderResult> }[] = [
  { id: 'chatgpt', fetch: fetchChatGPT },
  { id: 'claude', fetch: fetchClaude },
  { id: 'cursor', fetch: fetchCursor },
  { id: 'antigravity', fetch: fetchAntigravity }
]

export { fetchChatGPT, fetchClaude, fetchCursor, fetchAntigravity }

export function emptySnapshot(): ProviderResult[] {
  return PROVIDERS.map((p) => result(p.id, 'ok', { message: 'Waiting…', windows: [] }))
}
