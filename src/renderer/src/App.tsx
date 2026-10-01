import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProviderResult, UsageWindow } from '../../shared/types'
import chatgptIcon from './assets/icons/chatgpt.png'
import claudeIcon from './assets/icons/claude.png'
import cursorIcon from './assets/icons/cursor.png'
import antigravityIcon from './assets/icons/antigravity.png'

const ORDER: ProviderId[] = ['chatgpt', 'claude', 'cursor', 'antigravity']

const PROVIDER_NAMES: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor',
  antigravity: 'Antigravity'
}

const PROVIDER_ICONS: Record<ProviderId, string> = {
  chatgpt: chatgptIcon,
  claude: claudeIcon,
  cursor: cursorIcon,
  antigravity: antigravityIcon
}

const PLAN_DISPLAY: Record<string, string> = {
  'pro plus': 'Pro+',
  'pro+': 'Pro+'
}

function formatPlanName(plan?: string): string | null {
  if (!plan) return null
  const spaced = plan
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return null
  const mapped = PLAN_DISPLAY[spaced.toLowerCase()]
  if (mapped) return mapped
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

function ProviderIcon({ id }: { id: ProviderId }): React.JSX.Element {
  return <img className="provider-icon" src={PROVIDER_ICONS[id]} alt="" />
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg className="btn-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12a9 9 0 1 1-2.6-6.36M21 3v6h-6"
      />
    </svg>
  )
}

function barClass(pct: number): string {
  if (pct >= 90) return 'bar-fill high'
  if (pct >= 70) return 'bar-fill mid'
  return 'bar-fill'
}

function sentenceCase(s: string): string {
  const i = s.search(/\S/)
  if (i < 0) return s
  return s.slice(0, i) + s.charAt(i).toUpperCase() + s.slice(i + 1)
}

function formatCountdown(iso?: string, now = Date.now()): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'Resets soon'
  const totalMin = Math.floor(ms / 60_000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin - days * 60 * 24) / 60)
  const mins = totalMin % 60
  if (days > 0) return `Resets in ${days}d ${hours}h`
  if (hours > 0) return `Resets in ${hours}h ${mins}m`
  return `Resets in ${mins}m`
}

function periodSecondsFromLabel(label: string): number | undefined {
  const hours = label.match(/(\d+)-hour/i)
  if (hours) return Number(hours[1]) * 3600
  if (/weekly/i.test(label)) return 7 * 24 * 3600
  return undefined
}

function periodElapsedPercent(win: UsageWindow, now: number): number | null {
  const periodSeconds = win.periodSeconds ?? periodSecondsFromLabel(win.label)
  if (!win.resetsAt || !periodSeconds || periodSeconds <= 0) return null
  const reset = Date.parse(win.resetsAt)
  if (Number.isNaN(reset)) return null
  const elapsed = periodSeconds * 1000 - (reset - now)
  const pct = (elapsed / (periodSeconds * 1000)) * 100
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

function formatAmount(n?: number): string | null {
  if (typeof n !== 'number') return null
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (n >= 10) return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const sec = Math.max(0, Math.round((now - t) / 1000))
  if (sec < 60) return 'Just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function WindowRow({ win, now }: { win: UsageWindow; now: number }): React.JSX.Element {
  const used = formatAmount(win.used)
  const limit = formatAmount(win.limit)
  const counts = used && limit ? `${used} / ${limit}` : null
  const reset = formatCountdown(win.resetsAt, now)
  const elapsed = periodElapsedPercent(win, now)
  const pace =
    elapsed == null
      ? null
      : win.usedPercent > elapsed + 2
        ? 'Ahead of even pace'
        : win.usedPercent < elapsed - 2
          ? 'Behind even pace'
          : 'On even pace'
  return (
    <div className="window">
      <div className="window-head">
        <span className="window-label">{sentenceCase(win.label)}</span>
        <span className="window-pct">{Math.round(win.usedPercent)}%</span>
      </div>
      <div
        className="bar"
        title={
          elapsed == null
            ? undefined
            : `${Math.round(elapsed)}% through period · ${pace}`
        }
      >
        <div className="bar-track">
          <div
            className={barClass(win.usedPercent)}
            style={{ width: `${Math.min(100, win.usedPercent)}%` }}
          />
        </div>
        {elapsed != null ? (
          <div className="bar-tick" style={{ left: `${elapsed}%` }} />
        ) : null}
      </div>
      <div className="window-meta">
        {counts ? <span>{counts}</span> : <span />}
        {reset ? <span>{reset}</span> : <span />}
      </div>
    </div>
  )
}

function Card({ provider, now }: { provider: ProviderResult; now: number }): React.JSX.Element {
  const plan = formatPlanName(provider.plan)
  return (
    <article className="card">
      <header className="card-head">
        <div className="card-title">
          <ProviderIcon id={provider.id} />
          <h2>{PROVIDER_NAMES[provider.id]}</h2>
          {plan ? <span className="plan">{plan}</span> : null}
        </div>
        <span className="updated" title={new Date(provider.fetchedAt).toLocaleString()}>
          {formatRelative(provider.fetchedAt, now)}
        </span>
      </header>
      {provider.windows.length > 0 ? (
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

  const cards = useMemo(() => {
    const byId = new Map(snapshot.map((p) => [p.id, p]))
    return ORDER.map((id) => byId.get(id)).filter((p): p is ProviderResult => !!p)
  }, [snapshot])

  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || typeof window.ap.setPopupHeight !== 'function') return

    const report = (): void => {
      const height = Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height))
      if (height > 0) window.ap.setPopupHeight(height)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [cards])

  return (
    <div className="app" ref={rootRef}>
      <header className="top">
        <div>
          <h1>AP</h1>
          <p className="sub">AI Points</p>
        </div>
        <button
          className={refreshing ? 'btn btn-icon spinning' : 'btn btn-icon'}
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={refreshing ? 'Refreshing' : 'Refresh'}
          title="Refresh"
        >
          <RefreshIcon />
        </button>
      </header>
      <main className="cards">
        {cards.length === 0 ? <p className="message">Waiting for first poll…</p> : null}
        {cards.map((p) => (
          <Card key={p.id} provider={p} now={now} />
        ))}
      </main>
    </div>
  )
}
