import { execFile } from 'child_process'
import http from 'http'
import https from 'https'
import { result, clampPct, toIso, type ProviderResult, type UsageWindow } from './types'

interface LsProcess {
  ProcessId: number
  Name?: string | null
  ExecutablePath?: string | null
  CommandLine?: string | null
}

const RPC_PATHS = [
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
  '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs'
]

const GEMINI_LABEL = 'Gemini Models'
const CLAUDE_GPT_LABEL = 'Claude and GPT models'

const RPC_BODY = JSON.stringify({
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    ideVersion: 'unknown',
    locale: 'en'
  }
})

function ps(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 12_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      }
    )
  })
}

function parseJson<T>(text: string): T | T[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T | T[]
  } catch {
    return null
  }
}

function asArray<T>(v: T | T[] | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function blob(proc: LsProcess): string {
  return `${proc.Name ?? ''} ${proc.ExecutablePath ?? ''} ${proc.CommandLine ?? ''}`
}

function isAgy(proc: LsProcess): boolean {
  const name = (proc.Name ?? '').toLowerCase()
  if (name === 'agy.exe' || name === 'agy') return true
  const path = (proc.ExecutablePath ?? '').replace(/\\/g, '/').toLowerCase()
  return /(^|\/)agy\.exe$/.test(path)
}

function isAntigravityLs(proc: LsProcess): boolean {
  const name = (proc.Name ?? '').toLowerCase()
  if (!name.startsWith('language_server')) return false
  return /antigravity/i.test(blob(proc))
}

function csrfFromCommandLine(cmd: string | null | undefined): string | null {
  if (!cmd) return null
  const eq = cmd.match(/--csrf_token(?:=|\s+)(\S+)/)
  return eq?.[1]?.replace(/^["']|["']$/g, '') ?? null
}

function extensionPort(cmd: string | null | undefined): number | null {
  if (!cmd) return null
  const m = cmd.match(/--extension_server_port(?:=|\s+)(\d+)/)
  return m ? Number(m[1]) : null
}

function postLocal(
  protocol: 'https' | 'http',
  port: number,
  path: string,
  csrf: string | null,
  timeoutMs = 8000
): Promise<unknown> {
  const transport = protocol === 'https' ? https : http
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'Content-Length': Buffer.byteLength(RPC_BODY)
  }
  if (csrf) headers['X-Codeium-Csrf-Token'] = csrf

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          if (!text.trim()) {
            resolve({})
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error('Invalid JSON from language server'))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('Language server request timed out'))
    })
    req.write(RPC_BODY)
    req.end()
  })
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function remainingFraction(v: unknown): number | undefined {
  const obj = rec(v)
  if (!obj) return undefined
  const nested = rec(obj.remaining)
  const n =
    obj.remainingFraction ??
    obj.remaining_fraction ??
    nested?.remainingFraction ??
    nested?.remaining_fraction ??
    nested?.value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

const WEEK_SECONDS = 7 * 24 * 3600

function quotaWindow(
  remaining: number,
  reset: unknown,
  label: string,
  periodSeconds?: number
): UsageWindow {
  return {
    label,
    usedPercent: clampPct((1 - remaining) * 100),
    resetsAt: toIso(reset),
    periodSeconds
  }
}

function isWeeklyBucket(bucket: Record<string, unknown>): boolean {
  const id = String(bucket.bucketId ?? bucket.bucket_id ?? '').toLowerCase()
  const window = String(bucket.window ?? '').toLowerCase()
  const name = String(bucket.displayName ?? bucket.display_name ?? '').toLowerCase()
  return id.includes('weekly') || window === 'weekly' || name.includes('weekly')
}

function isGeminiName(name: string, bucketId = ''): boolean {
  const id = bucketId.toLowerCase()
  if (id.startsWith('gemini')) return true
  if (id.startsWith('3p')) return false
  return /gemini/i.test(name)
}

function isClaudeGptName(name: string, bucketId = ''): boolean {
  const id = bucketId.toLowerCase()
  if (id.startsWith('3p')) return true
  if (id.startsWith('gemini')) return false
  return /claude|gpt|oss/i.test(name)
}

function mapSummary(data: unknown): UsageWindow[] {
  const root = rec(data)
  const response = rec(root?.response) ?? root
  const groups = asArray(response?.groups ?? response?.Groups)
  const picked = new Map<string, UsageWindow>()

  for (const group of groups) {
    const g = rec(group)
    if (!g) continue
    const groupName = String(g.displayName ?? g.display_name ?? '')
    const buckets = asArray(g.buckets ?? g.Buckets)
      .map(rec)
      .filter((b): b is Record<string, unknown> => !!b)
    const weekly = buckets.find(isWeeklyBucket) ?? buckets[0]
    if (!weekly) continue
    const remaining = remainingFraction(weekly)
    if (typeof remaining !== 'number') continue
    const bucketId = String(weekly.bucketId ?? weekly.bucket_id ?? '')
    const label = isGeminiName(groupName, bucketId)
      ? GEMINI_LABEL
      : isClaudeGptName(groupName, bucketId)
        ? CLAUDE_GPT_LABEL
        : null
    if (!label || picked.has(label)) continue
    picked.set(
      label,
      quotaWindow(
        remaining,
        weekly.resetTime ?? weekly.reset_time,
        label,
        isWeeklyBucket(weekly) ? WEEK_SECONDS : undefined
      )
    )
  }

  return [GEMINI_LABEL, CLAUDE_GPT_LABEL]
    .map((label) => picked.get(label))
    .filter((w): w is UsageWindow => !!w)
}

function modelLabel(cfg: Record<string, unknown>): string {
  return (
    (typeof cfg.label === 'string' && cfg.label) ||
    (typeof cfg.displayName === 'string' && cfg.displayName) ||
    (typeof cfg.display_name === 'string' && cfg.display_name) ||
    (typeof cfg.modelName === 'string' && cfg.modelName) ||
    (typeof cfg.model_name === 'string' && cfg.model_name) ||
    (typeof cfg.modelId === 'string' && cfg.modelId) ||
    (typeof cfg.model_id === 'string' && cfg.model_id) ||
    ''
  )
}

function mapModels(data: unknown): UsageWindow[] {
  const root = rec(data)
  const status = rec(root?.userStatus ?? root?.user_status)
  const cascade = rec(status?.cascadeModelConfigData ?? status?.cascade_model_config_data)
  const configs = asArray(
    cascade?.clientModelConfigs ??
      cascade?.client_model_configs ??
      root?.clientModelConfigs ??
      root?.client_model_configs
  )
    .map(rec)
    .filter((c): c is Record<string, unknown> => !!c)

  const groups: Record<string, { remaining: number; reset?: unknown }> = {}
  for (const cfg of configs) {
    const q = rec(cfg.quotaInfo ?? cfg.quota_info)
    const remaining = remainingFraction(q)
    if (!q || typeof remaining !== 'number') continue
    const name = modelLabel(cfg)
    const label = isGeminiName(name)
      ? GEMINI_LABEL
      : isClaudeGptName(name)
        ? CLAUDE_GPT_LABEL
        : null
    if (!label) continue
    const reset = q.resetTime ?? q.reset_time
    const prev = groups[label]
    // Shared pools: keep the most-used (lowest remaining) row as the group value.
    if (!prev || remaining < prev.remaining) groups[label] = { remaining, reset }
  }

  return [GEMINI_LABEL, CLAUDE_GPT_LABEL]
    .filter((label) => groups[label])
    .map((label) =>
      quotaWindow(groups[label].remaining, groups[label].reset, label, WEEK_SECONDS)
    )
}

function mapQuota(data: unknown): UsageWindow[] {
  const summary = mapSummary(data)
  if (summary.length > 0) return summary
  return mapModels(data)
}

function planName(data: unknown): string | undefined {
  const root = rec(data)
  const status = rec(root?.userStatus ?? root?.user_status)
  const planStatus = rec(status?.planStatus ?? status?.plan_status)
  const planInfo = rec(planStatus?.planInfo ?? planStatus?.plan_info)
  const name = planInfo?.planName ?? planInfo?.plan_name
  return typeof name === 'string' ? name : undefined
}

async function listeningPorts(pid: number, cmd: string | null | undefined): Promise<number[]> {
  const ports = new Set<number>()
  const extra = extensionPort(cmd)
  if (extra) ports.add(extra)

  try {
    const out = await ps(
      `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort | ConvertTo-Json -Compress`
    )
    const rows = asArray(parseJson<{ LocalAddress?: string; LocalPort?: number }>(out))
    for (const r of rows) {
      const a = r.LocalAddress ?? ''
      if (
        typeof r.LocalPort === 'number' &&
        (a === '127.0.0.1' || a === '::' || a === '::1' || a === '0.0.0.0' || a === '')
      ) {
        ports.add(r.LocalPort)
      }
    }
  } catch {
    // fall through to netstat
  }

  if (ports.size === 0) {
    const netstat = await ps(`netstat -ano | Select-String '${pid}'`)
    for (const line of netstat.split(/\r?\n/)) {
      const m =
        line.match(/127\.0\.0\.1:(\d+).+LISTENING/i) || line.match(/\[::1\]:(\d+).+LISTENING/i)
      if (m) ports.add(Number(m[1]))
    }
  }

  return [...ports]
}

export async function fetchAntigravity(): Promise<ProviderResult> {
  let procs: LsProcess[]
  try {
    const out = await ps(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -or $_.Name -eq 'agy.exe' } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress"
    )
    procs = asArray(parseJson<LsProcess>(out)).filter((p) => isAgy(p) || isAntigravityLs(p))
  } catch (e) {
    return result('antigravity', 'error', { message: e instanceof Error ? e.message : String(e) })
  }

  if (procs.length === 0) {
    return result('antigravity', 'not_running', {
      message: 'Antigravity is not running. Open the app to see usage.'
    })
  }

  const errors: string[] = []
  for (const proc of procs) {
    const csrf = csrfFromCommandLine(proc.CommandLine)

    let ports: number[] = []
    try {
      ports = await listeningPorts(proc.ProcessId, proc.CommandLine)
    } catch (e) {
      errors.push(`pid ${proc.ProcessId}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    if (ports.length === 0) {
      errors.push(`pid ${proc.ProcessId}: no listening ports`)
      continue
    }

    const targets: Array<{ protocol: 'https' | 'http'; port: number }> = []
    for (const port of ports) {
      for (const protocol of ['https', 'http'] as const) {
        try {
          await postLocal(
            protocol,
            port,
            '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            csrf,
            2500
          )
          targets.push({ protocol, port })
        } catch {
          // not the Connect-RPC port
        }
      }
    }

    const attempts = targets.length > 0 ? targets : ports.flatMap((port) =>
      (['https', 'http'] as const).map((protocol) => ({ protocol, port }))
    )

    for (const { protocol, port } of attempts) {
      for (const path of RPC_PATHS) {
        try {
          const data = await postLocal(protocol, port, path, csrf)
          const windows = mapQuota(data)
          if (windows.length === 0) {
            errors.push(`${protocol} ${port}: no quotaInfo`)
            continue
          }
          return result('antigravity', 'ok', { windows, plan: planName(data) })
        } catch (e) {
          errors.push(`${protocol} ${port}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  return result('antigravity', 'error', {
    message: errors.slice(0, 3).join('; ') || 'Could not reach the Antigravity language server.'
  })
}
