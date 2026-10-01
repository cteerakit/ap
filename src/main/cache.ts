import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PROVIDERS } from './providers'
import { result, type ProviderId, type ProviderResult } from './providers/types'

const FILE = 'usage-cache.json'
const IDS = new Set<ProviderId>(PROVIDERS.map((p) => p.id))

function cachePath(): string {
  return join(app.getPath('userData'), FILE)
}

function asProvider(raw: unknown): ProviderResult | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !IDS.has(o.id as ProviderId)) return null
  if (typeof o.fetchedAt !== 'string' || !Array.isArray(o.windows)) return null
  return {
    id: o.id as ProviderId,
    status: o.status === 'ok' ? 'ok' : 'error',
    plan: typeof o.plan === 'string' ? o.plan : undefined,
    message: typeof o.message === 'string' ? o.message : undefined,
    windows: o.windows as ProviderResult['windows'],
    fetchedAt: o.fetchedAt
  }
}

export function hasUsage(p: ProviderResult): boolean {
  return p.windows.length > 0
}

export function loadCache(): ProviderResult[] {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    const byId = new Map<ProviderId, ProviderResult>()
    for (const item of parsed) {
      const p = asProvider(item)
      if (p && hasUsage(p)) byId.set(p.id, { ...p, status: 'ok' })
    }
    return PROVIDERS.map(
      (p) => byId.get(p.id) ?? result(p.id, 'ok', { message: 'Waiting…', windows: [] })
    )
  } catch {
    return []
  }
}

export function saveCache(snapshot: ProviderResult[]): void {
  const usable = snapshot.filter(hasUsage)
  if (usable.length === 0) return
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(usable))
  } catch {
    // Cache is best-effort.
  }
}

export function keepLastUsage(
  fresh: ProviderResult[],
  previous: ProviderResult[]
): ProviderResult[] {
  const prev = new Map(previous.filter(hasUsage).map((p) => [p.id, p]))
  return fresh.map((p) => {
    if (hasUsage(p)) return p
    const cached = prev.get(p.id)
    return cached ?? p
  })
}
