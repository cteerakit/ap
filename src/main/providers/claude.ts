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

const LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)'
}

const PERIOD_SECONDS: Record<string, number> = {
  five_hour: 5 * 3600,
  seven_day: 7 * 24 * 3600,
  seven_day_opus: 7 * 24 * 3600,
  seven_day_sonnet: 7 * 24 * 3600
}

function parseWindows(data: Record<string, unknown>): UsageWindow[] {
  const out: UsageWindow[] = []
  for (const [key, label] of Object.entries(LABELS)) {
    const w = data[key]
    if (
      w &&
      typeof w === 'object' &&
      typeof (w as { utilization?: unknown }).utilization === 'number'
    ) {
      const rec = w as { utilization: number; resets_at?: unknown }
      out.push({
        label,
        usedPercent: clampPct(rec.utilization),
        resetsAt: toIso(rec.resets_at),
        periodSeconds: PERIOD_SECONDS[key]
      })
    }
  }
  return out
}

export async function fetchClaude(): Promise<ProviderResult> {
  const credPath = join(homedir(), '.claude', '.credentials.json')
  let raw: string
  try {
    raw = await readFile(credPath, 'utf8')
  } catch {
    return result('claude', 'not_found', {
      message: 'No Claude Code login found. Open Claude Code to sign in.'
    })
  }

  let accessToken: string | undefined
  let expiresAt: unknown
  try {
    const json = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: unknown }
    }
    accessToken = json.claudeAiOauth?.accessToken
    expiresAt = json.claudeAiOauth?.expiresAt
  } catch {
    return result('claude', 'error', { message: 'Could not parse ~/.claude/.credentials.json' })
  }

  if (!accessToken) {
    return result('claude', 'not_found', { message: 'Open Claude Code to re-login.' })
  }

  const expIso = toIso(expiresAt)
  if (expIso && Date.parse(expIso) < Date.now()) {
    return result('claude', 'expired', { message: 'Open Claude Code to re-login.' })
  }

  try {
    const data = (await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0.0'
      }
    })) as Record<string, unknown>
    return result('claude', 'ok', { windows: parseWindows(data) })
  } catch (e) {
    if (e instanceof AuthError) {
      return result('claude', 'expired', { message: 'Open Claude Code to re-login.' })
    }
    return result('claude', 'error', { message: e instanceof Error ? e.message : String(e) })
  }
}
