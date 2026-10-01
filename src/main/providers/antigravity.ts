import { execFile } from 'child_process'
import https from 'https'
import { result, clampPct, toIso, type ProviderResult, type UsageWindow } from './types'

interface LsProcess {
  ProcessId: number
  CommandLine?: string | null
}

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

function csrfFromCommandLine(cmd: string | null | undefined): string | null {
  if (!cmd) return null
  const eq = cmd.match(/--csrf_token(?:=|\s+)(\S+)/)
  return eq?.[1]?.replace(/^["']|["']$/g, '') ?? null
}

function postLocal(port: number, csrf: string): Promise<unknown> {
  const body = '{}'
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrf,
          'Content-Length': Buffer.byteLength(body)
        }
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
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error('Invalid JSON from language server'))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(8000, () => {
      req.destroy()
      reject(new Error('Language server request timed out'))
    })
    req.write(body)
    req.end()
  })
}

function mapQuota(data: unknown): UsageWindow[] {
  const root = data as Record<string, unknown>
  const status = (root.userStatus ?? root.user_status) as Record<string, unknown> | undefined
  const cascade = (status?.cascadeModelConfigData ?? status?.cascade_model_config_data) as
    Record<string, unknown> | undefined
  const configs = (cascade?.clientModelConfigs ?? cascade?.client_model_configs ?? []) as Array<
    Record<string, unknown>
  >
  const windows: UsageWindow[] = []
  for (const cfg of configs) {
    const q = (cfg.quotaInfo ?? cfg.quota_info) as
      | {
          remainingFraction?: number
          remaining_fraction?: number
          resetTime?: unknown
          reset_time?: unknown
        }
      | undefined
    const remaining = q?.remainingFraction ?? q?.remaining_fraction
    if (!q || typeof remaining !== 'number') continue
    const label =
      (typeof cfg.displayName === 'string' && cfg.displayName) ||
      (typeof cfg.display_name === 'string' && cfg.display_name) ||
      (typeof cfg.modelName === 'string' && cfg.modelName) ||
      (typeof cfg.model_name === 'string' && cfg.model_name) ||
      (typeof cfg.modelId === 'string' && cfg.modelId) ||
      (typeof cfg.model_id === 'string' && cfg.model_id) ||
      'Model'
    windows.push({
      label,
      usedPercent: clampPct((1 - remaining) * 100),
      resetsAt: toIso(q.resetTime ?? q.reset_time)
    })
  }
  windows.sort((a, b) => a.label.localeCompare(b.label))
  return windows
}

export async function fetchAntigravity(): Promise<ProviderResult> {
  let procs: LsProcess[]
  try {
    const out = await ps(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'language_server_windows_x64.exe' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
    )
    procs = asArray(parseJson<LsProcess>(out))
  } catch (e) {
    return result('antigravity', 'error', { message: e instanceof Error ? e.message : String(e) })
  }

  if (procs.length === 0) {
    return result('antigravity', 'not_running', {
      message: 'Antigravity is not running. Open the IDE to see usage.'
    })
  }

  const errors: string[] = []
  for (const proc of procs) {
    const csrf = csrfFromCommandLine(proc.CommandLine)
    if (!csrf) {
      errors.push(`pid ${proc.ProcessId}: no --csrf_token`)
      continue
    }
    let ports: number[] = []
    try {
      const out = await ps(
        `Get-NetTCPConnection -OwningProcess ${proc.ProcessId} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort | ConvertTo-Json -Compress`
      )
      const rows = asArray(parseJson<{ LocalAddress?: string; LocalPort?: number }>(out))
      ports = [
        ...new Set(
          rows
            .filter((r) => {
              const a = r.LocalAddress ?? ''
              return a === '127.0.0.1' || a === '::' || a === '::1' || a === '0.0.0.0' || a === ''
            })
            .map((r) => r.LocalPort)
            .filter((p): p is number => typeof p === 'number')
        )
      ]
      if (ports.length === 0) {
        const netstat = await ps(`netstat -ano | Select-String '${proc.ProcessId}'`)
        for (const line of netstat.split(/\r?\n/)) {
          const m =
            line.match(/127\.0\.0\.1:(\d+).+LISTENING/i) || line.match(/\[::1\]:(\d+).+LISTENING/i)
          if (m) ports.push(Number(m[1]))
        }
        ports = [...new Set(ports)]
      }
    } catch (e) {
      errors.push(`pid ${proc.ProcessId}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    for (const port of ports) {
      try {
        const data = await postLocal(port, csrf)
        const windows = mapQuota(data)
        if (windows.length === 0) {
          errors.push(`port ${port}: no quotaInfo`)
          continue
        }
        return result('antigravity', 'ok', { windows })
      } catch (e) {
        errors.push(`port ${port}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return result('antigravity', 'error', {
    message: errors.slice(0, 3).join('; ') || 'Could not reach the Antigravity language server.'
  })
}
