import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import {
  AuthError,
  clampPct,
  fetchJson,
  result,
  toIso,
  type ProviderResult,
  type UsageWindow
} from './types'

function windowLabel(base: string, w: Record<string, unknown> | undefined): string {
  const secs = w?.limit_window_seconds
  if (typeof secs === 'number' && secs > 0) {
    const h = Math.round(secs / 3600)
    if (h >= 24 * 6) return 'Weekly'
    if (h === 5) return '5-hour'
    if (h >= 1) return `${h}-hour`
  }
  return base
}

function parseWindow(label: string, w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const rec = w as Record<string, unknown>
  if (typeof rec.used_percent !== 'number') return null
  let resetsAt = toIso(rec.reset_at)
  if (!resetsAt && typeof rec.reset_after_seconds === 'number') {
    resetsAt = new Date(Date.now() + rec.reset_after_seconds * 1000).toISOString()
  }
  const periodSeconds =
    typeof rec.limit_window_seconds === 'number' && rec.limit_window_seconds > 0
      ? rec.limit_window_seconds
      : undefined
  return { label, usedPercent: clampPct(rec.used_percent), resetsAt, periodSeconds }
}

export async function fetchChatGPT(): Promise<ProviderResult> {
  const authPath = join(homedir(), '.codex', 'auth.json')
  let raw: string
  try {
    raw = await readFile(authPath, 'utf8')
  } catch {
    return result('chatgpt', 'not_found', {
      message: 'No Codex login found. Open Codex to sign in.'
    })
  }

  let access: string | undefined
  let accountId: string | undefined
  try {
    const json = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } }
    access = json.tokens?.access_token
    accountId = json.tokens?.account_id
  } catch {
    return result('chatgpt', 'error', { message: 'Could not parse ~/.codex/auth.json' })
  }

  if (!access) {
    return result('chatgpt', 'not_found', { message: 'Open Codex to re-login.' })
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    'User-Agent': 'codex_cli_rs/0.50.0'
  }
  if (accountId) headers['ChatGPT-Account-Id'] = accountId

  try {
    const data = (await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
      headers
    })) as Record<string, unknown>
    const rl = (data.rate_limit ?? {}) as Record<string, unknown>
    const windows = [
      parseWindow(
        windowLabel('5-hour', rl.primary_window as Record<string, unknown>),
        rl.primary_window
      ),
      parseWindow(
        windowLabel('Weekly', rl.secondary_window as Record<string, unknown>),
        rl.secondary_window
      )
    ].filter((w): w is UsageWindow => !!w)

    const cr = (data.code_review_rate_limit as Record<string, unknown> | undefined)?.primary_window
    const crw = parseWindow('Code review (weekly)', cr)
    if (crw) windows.push(crw)

    const planName = [data.plan_name, data.plan_type].find((v) => typeof v === 'string') as
      | string
      | undefined

    return result('chatgpt', 'ok', {
      plan: planName,
      windows
    })
  } catch (e) {
    if (e instanceof AuthError) {
      return result('chatgpt', 'expired', { message: 'Open Codex to re-login.' })
    }
    return result('chatgpt', 'error', { message: e instanceof Error ? e.message : String(e) })
  }
}
