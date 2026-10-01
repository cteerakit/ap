import type { ProviderId, ProviderResult, ProviderStatus } from '../../shared/types'

export {
  PROVIDER_NAMES,
  type ProviderId,
  type ProviderResult,
  type ProviderStatus,
  type UsageWindow
} from '../../shared/types'

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export function toIso(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v
    return new Date(ms).toISOString()
  }
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return new Date(t).toISOString()
    const n = Number(v)
    if (!Number.isNaN(n)) return toIso(n)
  }
  return undefined
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(12_000) })
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Rejected by ${new URL(url).host} (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`${new URL(url).host} returned HTTP ${res.status}: ${body}`)
  }
  return res.json()
}

export function result(
  id: ProviderId,
  status: ProviderStatus,
  extra: Partial<ProviderResult> = {}
): ProviderResult {
  return {
    id,
    status,
    windows: extra.windows ?? [],
    fetchedAt: extra.fetchedAt ?? nowIso(),
    plan: extra.plan,
    message: extra.message
  }
}
