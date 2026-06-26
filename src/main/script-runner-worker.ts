import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
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
    // If postMessage fails for any reason (e.g. non-clonable object), swallow the
    // error so it never propagates back into the user's script execution.
  }
}

// Pending job requests: reqId → { resolve, reject }
const pendingJobRequests = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

// Listen for replies from the main process (job results, getFailedRows, updateTableWithIds results).
parentPort!.on('message', (msg: { type: string } & Record<string, unknown>) => {
  const reqId = msg.reqId as string | undefined
  if (!reqId) return
  const pending = pendingJobRequests.get(reqId)
  if (!pending) return
  pendingJobRequests.delete(reqId)

  if (
    msg.type === 'runExtractResult' ||
    msg.type === 'runWritebackResult' ||
    msg.type === 'getFailedRowsResult' ||
    msg.type === 'updateTableWithIdsResult'
  ) {
    pending.resolve(msg.result)
  } else if (
    msg.type === 'runExtractError' ||
    msg.type === 'runWritebackError' ||
    msg.type === 'getFailedRowsError' ||
    msg.type === 'updateTableWithIdsError'
  ) {
    pending.reject(new Error(msg.error as string))
  }
})

function sendJobRequest(type: string, payload: Record<string, unknown>): Promise<unknown> {
  const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36)
  return new Promise((resolve, reject) => {
    pendingJobRequests.set(reqId, { resolve, reject })
    parentPort!.postMessage({ type, reqId, ...payload })
  })
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

    // db.progress(value)            — value is 0-100 (percentage)
    // db.progress(value, total)     — value/total, percentage auto-calculated
    // db.progress(value, total, label) — with a label
    progress: (value: number, total?: number, label?: string): void => {
      parentPort!.postMessage({ type: 'progress', value, total, label })
    }
  }

  const consoleApi = {
    log: (...args: unknown[]): void => sendLog('log', args),
    warn: (...args: unknown[]): void => sendLog('warn', args),
    error: (...args: unknown[]): void => sendLog('error', args)
  }

  // jobs API — lets scripts trigger download and writeback jobs by name and await
  // their completion, respecting the same MAX_PARALLEL queue as the UI.
  // Row-level data (failedRows, keyFields) is fetched lazily via getFailedRows
  // to avoid cloning potentially large datasets into the worker thread.
  const jobsApi = {
    runDownload: (name: string): Promise<{ rowsLoaded: number }> =>
      sendJobRequest('runExtract', { name }) as Promise<{ rowsLoaded: number }>,

    runWriteback: (name: string): Promise<{
      _runId: string
      status: string
      rowsSucceeded: number
      rowsFailed: number
    }> => sendJobRequest('runWriteback', { name }) as Promise<{
      _runId: string
      status: string
      rowsSucceeded: number
      rowsFailed: number
    }>,

    getFailedRows: (result: { _runId: string }): Promise<{
      failedRows: Array<{ index: number; message: string; row: Record<string, unknown> }>
      keyFields: Array<{ sfField: string; sqlCol: string; label: string }>
    }> => sendJobRequest('getFailedRows', { runId: result._runId }) as Promise<{
      failedRows: Array<{ index: number; message: string; row: Record<string, unknown> }>
      keyFields: Array<{ sfField: string; sqlCol: string; label: string }>
    }>,

    updateTableWithIds: (
      result: { _runId: string },
      opts: { sfKeyField: string; targetTable: string; tableKeyCol: string; idColumnName: string }
    ): Promise<{ updated: number; idColCreated: boolean; indexCreated: boolean }> =>
      sendJobRequest('updateTableWithIds', { runId: result._runId, ...opts }) as Promise<{
        updated: number
        idColCreated: boolean
        indexCreated: boolean
      }>
  }

  const startTs = Date.now()

  try {
    // AsyncFunction lets the user write top-level await and for-of loops with
    // native better-sqlite3 iterators — all in the same V8 context, so
    // Symbol.iterator works without any cross-context complications.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...fnArgs: unknown[]) => Promise<unknown>

    const fn = new AsyncFunction('db', 'console', 'jobs', code)
    await fn(dbApi, consoleApi, jobsApi)

    parentPort!.postMessage({ type: 'done', durationMs: Date.now() - startTs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack : null
    sendLog('error', [stack ?? message])
    parentPort!.postMessage({
      type: 'error',
      message,
      durationMs: Date.now() - startTs
    })
  } finally {
    d.close()
  }
}

main()
