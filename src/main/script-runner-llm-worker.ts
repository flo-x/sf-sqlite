import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
import vm from 'vm'
import type { ScriptLog } from '../shared/types'

interface WorkerData {
  code: string
  dbPath: string
  runId: string
}

function stringify(a: unknown): string {
  if (a === null) return 'null'
  if (a === undefined) return 'undefined'
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  return String(a)
}

function sendLog(level: ScriptLog['level'], rawArgs: unknown[]): void {
  try {
    const args = rawArgs.map(stringify)
    parentPort!.postMessage({ type: 'log', level, args, ts: Date.now() })
  } catch {
    // If postMessage fails for any reason (e.g. non-clonable object), swallow
    // the error so it never propagates back into the script execution.
  }
}

async function main(): Promise<void> {
  const { code, dbPath } = workerData as WorkerData
  const d = new Database(dbPath)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')

  const dbApi = {
    query: (sql: string, params?: unknown[]): { columns: string[]; rows: unknown[][] } => {
      const stmt = d.prepare(sql)
      const rows = params?.length ? stmt.all(...params) : stmt.all()
      const columns = rows.length > 0 ? Object.keys(rows[0] as object) : stmt.columns().map((c) => c.name)
      return { columns, rows: rows.map((r) => Object.values(r as object)) }
    },

    iterate: (sql: string, params?: unknown[]): IterableIterator<Record<string, unknown>> => {
      const stmt = d.prepare(sql)
      return (params?.length ? stmt.iterate(...params) : stmt.iterate()) as IterableIterator<Record<string, unknown>>
    },

    execute: (sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } => {
      const stmt = d.prepare(sql)
      const info = params?.length ? stmt.run(...params) : stmt.run()
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }
    },

    transaction: (fn: () => void): void => {
      d.transaction(fn)()
    },
  }

  const consoleApi = {
    log: (...args: unknown[]): void => sendLog('log', args),
    warn: (...args: unknown[]): void => sendLog('warn', args),
    error: (...args: unknown[]): void => sendLog('error', args),
  }

  const startTs = Date.now()

  try {
    // Build a null-prototype context so scripts cannot escape into the Node.js
    // realm via prototype-chain tricks (e.g. ({}).constructor.constructor).
    // Only db and console are exposed — process, fetch, Buffer, crypto etc.
    // are intentionally omitted.
    const ctx = vm.createContext(Object.create(null) as Record<string, unknown>)
    ctx['db'] = dbApi
    ctx['console'] = consoleApi

    // Wrap the user code in an async IIFE so that top-level await is supported.
    // vm.compileFunction creates a synchronous outer function; the async IIFE
    // inside is what actually drives the user's async code.
    // importModuleDynamically rejects any import() call, preventing access to
    // Node.js built-in modules (fs, child_process, net, etc.).
    const wrappedCode = `return (async () => {\n${code}\n})()`
    const fn = vm.compileFunction(wrappedCode, [], {
      parsingContext: ctx,
      importModuleDynamically: () => Promise.reject(new Error('import() is not allowed in LLM scripts')),
    } as Parameters<typeof vm.compileFunction>[2])

    await (fn() as Promise<unknown>)

    parentPort!.postMessage({ type: 'done', durationMs: Date.now() - startTs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack : null
    sendLog('error', [stack ?? message])
    parentPort!.postMessage({
      type: 'error',
      message,
      durationMs: Date.now() - startTs,
    })
  } finally {
    d.close()
  }
}

main()
