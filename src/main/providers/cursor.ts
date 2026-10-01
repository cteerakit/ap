import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import initSqlJs from 'sql.js'
import {
  AuthError,
  clampPct,
  decodeJwt,
  fetchJson,
  periodSecondsBetween,
  result,
  toIso,
  type ProviderResult,
  type UsageWindow
} from './types'

function wasmPath(): string {
  const candidates = [
    join(process.resourcesPath, 'sql-wasm.wasm'),
    join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
    join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('sql-wasm.wasm not found')
  return found
}

function vscdbPath(): string {
  const appData = process.env.APPDATA || join(app.getPath('appData'))
  return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function readTokenFromFile(file: string): string | null {
  try {
    // Electron 39 / Node 22+: native SQLite avoids loading the whole DB into RAM.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean }
      ) => {
        prepare: (sql: string) => { get: (...args: unknown[]) => { value?: string } | undefined }
        close: () => void
      }
    }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('cursorAuth/accessToken')
      return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

async function readAccessToken(): Promise<string | null> {
  const src = vscdbPath()
  if (!existsSync(src)) return null

  const direct = readTokenFromFile(src)
  if (direct) return direct

  const scratchRoot = join(__dirname, '../../.tmp')
  mkdirSync(scratchRoot, { recursive: true })
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(scratchRoot, 'cursor-'))
    const dest = join(dir, 'state.vscdb')
    copyFileSync(src, dest)
    const copied = readTokenFromFile(dest)
    if (copied) return copied

    const SQL = await initSqlJs({ locateFile: () => wasmPath() })
    const db = new SQL.Database(readFileSync(dest))
    const rows = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
    db.close()
    const value = rows[0]?.values?.[0]?.[0]
    return typeof value === 'string' && value.length > 0 ? value : null
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

function percentFromMessage(msg: unknown): number | undefined {
  if (typeof msg !== 'string') return undefined
  const m = msg.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

function pushPercentWindow(
  windows: UsageWindow[],
  label: string,
  pct: unknown,
  resetsAt?: string,
  periodSeconds?: number
): void {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return
  if (windows.some((w) => w.label === label)) return
  windows.push({ label, usedPercent: clampPct(pct), resetsAt, periodSeconds })
}

function cyclePeriod(s: Record<string, unknown>): { resetsAt?: string; periodSeconds?: number } {
  const resetsAt = toIso(s.billingCycleEnd)
  const start = toIso(s.billingCycleStart ?? s.billingCycleBegin ?? s.startOfMonth)
  let periodSeconds = periodSecondsBetween(start, resetsAt)
  if (!periodSeconds && resetsAt) {
    const end = Date.parse(resetsAt)
    const prior = new Date(end)
    prior.setUTCMonth(prior.getUTCMonth() - 1)
    periodSeconds = Math.round((end - prior.getTime()) / 1000)
  }
  return { resetsAt, periodSeconds }
}

function cookieFromJwt(raw: string): { cookie: string; userId: string | null } {
  let jwt = raw.trim()
  let userId: string | null = null
  if (jwt.includes('::')) {
    const [id, token] = jwt.split('::')
    userId = id || null
    jwt = token || jwt
  }
  const payload = decodeJwt(jwt)
  if (!userId && typeof payload?.sub === 'string') userId = payload.sub
  const cookie = userId
    ? `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${jwt}`)}`
    : `WorkosCursorSessionToken=${encodeURIComponent(jwt)}`
  return { cookie, userId }
}

export async function fetchCursor(): Promise<ProviderResult> {
  let jwt: string | null
  try {
    jwt = await readAccessToken()
  } catch (e) {
    return result('cursor', 'error', { message: e instanceof Error ? e.message : String(e) })
  }

  if (!jwt) {
    return result('cursor', 'not_found', {
      message: 'No Cursor login found. Open Cursor to sign in.'
    })
  }

  const { cookie, userId } = cookieFromJwt(jwt)
  const headers = {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json'
  }

  const windows: UsageWindow[] = []
  let plan: string | undefined

  try {
    const s = (await fetchJson('https://cursor.com/api/usage-summary', { headers })) as Record<
      string,
      unknown
    >
    plan = typeof s.membershipType === 'string' ? s.membershipType : undefined
    const { resetsAt, periodSeconds } = cyclePeriod(s)
    const ind = s.individualUsage as Record<string, unknown> | undefined
    const p = ind?.plan as Record<string, unknown> | undefined
    pushPercentWindow(windows, 'Cursor models', p?.autoPercentUsed, resetsAt, periodSeconds)
    pushPercentWindow(windows, 'Other models', p?.apiPercentUsed, resetsAt, periodSeconds)
    pushPercentWindow(
      windows,
      'Cursor models',
      percentFromMessage(s.autoModelSelectedDisplayMessage),
      resetsAt,
      periodSeconds
    )
    pushPercentWindow(
      windows,
      'Other models',
      percentFromMessage(s.namedModelSelectedDisplayMessage),
      resetsAt,
      periodSeconds
    )
    const od = ind?.onDemand as Record<string, unknown> | undefined
    if (od && typeof od.used === 'number' && od.used > 0 && typeof od.limit === 'number' && od.limit > 0) {
      windows.push({
        label: 'On-demand spend',
        usedPercent: clampPct((od.used / od.limit) * 100),
        used: od.used,
        limit: od.limit,
        resetsAt,
        periodSeconds
      })
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return result('cursor', 'expired', { message: 'Open Cursor to re-login.' })
    }
  }

  if (windows.length === 0 && userId) {
    try {
      const u = (await fetchJson(
        `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`,
        {
          headers
        }
      )) as Record<string, unknown>
      const start = toIso(u.startOfMonth)
      const resetsAt = start
        ? new Date(new Date(start).setUTCMonth(new Date(start).getUTCMonth() + 1)).toISOString()
        : undefined
      const periodSeconds = periodSecondsBetween(start, resetsAt)
      for (const [model, m] of Object.entries(u)) {
        if (
          m &&
          typeof m === 'object' &&
          typeof (m as { numRequests?: unknown }).numRequests === 'number'
        ) {
          const rec = m as { numRequests: number; maxRequestUsage?: number }
          if (rec.maxRequestUsage) {
            windows.push({
              label: `${model} requests`,
              usedPercent: clampPct((rec.numRequests / rec.maxRequestUsage) * 100),
              used: rec.numRequests,
              limit: rec.maxRequestUsage,
              resetsAt,
              periodSeconds
            })
          }
        }
      }
    } catch (e) {
      if (e instanceof AuthError) {
        return result('cursor', 'expired', { message: 'Open Cursor to re-login.' })
      }
      return result('cursor', 'error', { message: e instanceof Error ? e.message : String(e) })
    }
  }

  if (windows.length === 0) {
    return result('cursor', 'error', { message: 'Cursor returned no recognizable usage data.' })
  }
  return result('cursor', 'ok', { plan, windows })
}
