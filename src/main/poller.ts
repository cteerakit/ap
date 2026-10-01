import { keepLastUsage, loadCache, saveCache } from './cache'
import { PROVIDERS, emptySnapshot } from './providers'
import { PROVIDER_NAMES } from '../shared/types'
import { result, type ProviderResult } from './providers/types'

const TIMEOUT_MS = 15_000
const INTERVAL_MS = 5 * 60_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function tooltipFor(snapshot: ProviderResult[]): string {
  const bits = snapshot
    .filter((p) => p.status === 'ok' && p.windows.length > 0)
    .map((p) => {
      const top = p.windows[0]
      const name = PROVIDER_NAMES[p.id]
      const label = top.label.toLowerCase()
      const short =
        label.includes('5-hour') || label.includes('5h') ? '5h' : label.includes('week') ? 'wk' : ''
      return short
        ? `${name} ${short} ${Math.round(top.usedPercent)}%`
        : `${name} ${Math.round(top.usedPercent)}%`
    })
  return bits.length > 0 ? bits.join(' / ') : 'ap — no usage data'
}

export function maxUsage(snapshot: ProviderResult[]): number | null {
  let max: number | null = null
  for (const p of snapshot) {
    if (p.status !== 'ok') continue
    for (const w of p.windows) {
      if (max == null || w.usedPercent > max) max = w.usedPercent
    }
  }
  return max
}

export class Poller {
  snapshot: ProviderResult[]
  onChange: ((snapshot: ProviderResult[]) => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<ProviderResult[]> | null = null

  constructor() {
    const cached = loadCache()
    this.snapshot = cached.length > 0 ? cached : emptySnapshot()
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<ProviderResult[]> {
    if (this.inflight) return this.inflight
    this.inflight = this.poll()
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async poll(): Promise<ProviderResult[]> {
    const settled = await Promise.allSettled(
      PROVIDERS.map((p) =>
        withTimeout(p.fetch(), TIMEOUT_MS).catch((e) =>
          result(p.id, 'error', { message: e instanceof Error ? e.message : String(e) })
        )
      )
    )
    const fresh = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value
      return result(PROVIDERS[i].id, 'error', {
        message: s.reason instanceof Error ? s.reason.message : String(s.reason)
      })
    })
    this.snapshot = keepLastUsage(fresh, this.snapshot)
    saveCache(this.snapshot)
    this.onChange?.(this.snapshot)
    return this.snapshot
  }
}
