import { readFileSync } from 'fs'
import { parentPort, workerData } from 'worker_threads'
import initSqlJs from 'sql.js'

async function main(): Promise<void> {
  const { file, wasm } = workerData as { file: string; wasm: string }
  const SQL = await initSqlJs({ locateFile: () => wasm })
  const db = new SQL.Database(readFileSync(file))
  const rows = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
  db.close()
  const value = rows[0]?.values?.[0]?.[0]
  parentPort?.postMessage(typeof value === 'string' && value.length > 0 ? value : null)
}

main().catch((e) => {
  parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) })
})
