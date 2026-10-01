import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProviderId, ProviderResult, ProviderStatus, UsageWindow } from '../../shared/types'

const ORDER: ProviderId[] = ['chatgpt', 'claude', 'cursor', 'antigravity']

const PROVIDER_NAMES: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor',
  antigravity: 'Antigravity'
}

function barClass(pct: number): string {
  if (pct >= 90) return 'bar-fill high'
  if (pct >= 70) return 'bar-fill mid'
  return 'bar-fill'
}

function formatCountdown(iso?: string, now = Date.now()): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resets soon'
  const totalMin = Math.floor(ms / 60_000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin - days * 60 * 24) / 60)
  const mins = totalMin % 60
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${mins}m`
  return `resets in ${mins}m`
}

function formatAmount(n?: number): string | null {
  if (typeof n !== 'number') return null
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (n >= 10) return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function statusLabel(status: ProviderStatus): string {
  switch (status) {
    case 'ok':
      return 'OK'
    case 'not_found':
      return 'Not found'
    case 'expired':
      return 'Expired'
    case 'not_running':
      return 'Not running'
    default:
      return 'Error'
  }
}

function WindowRow({ win, now }: { win: UsageWindow; now: number }): React.JSX.Element {
  const used = formatAmount(win.used)
  const limit = formatAmount(win.limit)
  const counts = used && limit ? `${used} / ${limit}` : null
  const reset = formatCountdown(win.resetsAt, now)
  return (
    <div className="window">
      <div className="window-head">
        <span className="window-label">{win.label}</span>
        <span className="window-pct">{Math.round(win.usedPercent)}%</span>
      </div>
      <div className="bar">
        <div
          className={barClass(win.usedPercent)}
          style={{ width: `${Math.min(100, win.usedPercent)}%` }}
        />
      </div>
      <div className="window-meta">
        {counts ? <span>{counts}</span> : <span />}
        {reset ? <span>{reset}</span> : <span />}
      </div>
    </div>
  )
}

function Card({ provider, now }: { provider: ProviderResult; now: number }): React.JSX.Element {
  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h2>{PROVIDER_NAMES[provider.id]}</h2>
          {provider.plan ? <p className="plan">{provider.plan}</p> : null}
        </div>
        <span className={`badge badge-${provider.status}`}>{statusLabel(provider.status)}</span>
      </header>
      {provider.status === 'ok' && provider.windows.length > 0 ? (
        <div className="windows">
          {provider.windows.map((w) => (
            <WindowRow key={w.label} win={w} now={now} />
          ))}
        </div>
      ) : (
        <p className="message">
          {provider.message ?? (provider.status === 'ok' ? 'No windows reported.' : 'No data yet.')}
        </p>
      )}
    </article>
  )
}

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ProviderResult[]>([])
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.ap.get().then((s) => {
      if (!cancelled) setSnapshot(s)
    })
    void window.ap.getOpenAtLogin().then((v) => {
      if (!cancelled) setOpenAtLogin(v)
    })
    const off = window.ap.onUpdate((s) => setSnapshot(s))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const next = await window.ap.refresh()
      setSnapshot(next)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const toggleLogin = useCallback(async () => {
    const next = await window.ap.setOpenAtLogin(!openAtLogin)
    setOpenAtLogin(next)
  }, [openAtLogin])

  const cards = useMemo(() => {
    const byId = new Map(snapshot.map((p) => [p.id, p]))
    return ORDER.map((id) => byId.get(id)).filter((p): p is ProviderResult => !!p)
  }, [snapshot])

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Usage</h1>
          <p className="sub">ChatGPT, Claude, Cursor, Antigravity</p>
        </div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      <main className="cards">
        {cards.length === 0 ? <p className="message">Waiting for first poll…</p> : null}
        {cards.map((p) => (
          <Card key={p.id} provider={p} now={now} />
        ))}
      </main>
      <footer className="foot">
        <label className="check">
          <input type="checkbox" checked={openAtLogin} onChange={() => void toggleLogin()} />
          Open at login
        </label>
        <button className="btn ghost" type="button" onClick={() => void window.ap.quit()}>
          Quit
        </button>
      </footer>
    </div>
  )
}
