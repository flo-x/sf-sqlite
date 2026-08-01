import { Worker } from 'worker_threads'
import path from 'path'
import type { ScriptLog, ScriptComplete, ScriptProgress, JobResult, JobListEntry } from '../shared/types'
import type { WritebackScriptResult, WritebackFailedRowsResult } from './ipc-handlers'

type ExtractExecutor = (name: string) => Promise<JobResult>
type WritebackExecutor = (name: string) => Promise<WritebackScriptResult>
type UpdateTableExecutor = (
  runId: string,
  sfKeyField: string,
  targetTable: string,
  tableKeyCol: string,
  idColumnName: string
) => { updated: number; idColCreated: boolean; indexCreated: boolean }
type GetFailedRowsExecutor = (runId: string) => WritebackFailedRowsResult
type ListJobsExecutor = () => JobListEntry[]

let extractExecutor: ExtractExecutor | null = null
let writebackExecutor: WritebackExecutor | null = null
let updateTableExecutor: UpdateTableExecutor | null = null
let getFailedRowsExecutor: GetFailedRowsExecutor | null = null
let listJobsExecutor: ListJobsExecutor | null = null

export function setJobExecutors(
  extract: ExtractExecutor,
  writeback: WritebackExecutor,
  updateTable: UpdateTableExecutor,
  getFailedRows: GetFailedRowsExecutor,
  listJobs: ListJobsExecutor
): void {
  extractExecutor = extract
  writebackExecutor = writeback
  updateTableExecutor = updateTable
  getFailedRowsExecutor = getFailedRows
  listJobsExecutor = listJobs
}

const activeWorkers = new Map<string, Worker>()

export function runScript(
  dbPath: string,
  code: string,
  runId: string,
  onLog: (log: ScriptLog) => void,
  onComplete: (result: ScriptComplete) => void,
  onProgress?: (p: ScriptProgress) => void
): void {
  const workerPath = path.join(__dirname, 'script-runner-worker.js')
  const worker = new Worker(workerPath, { workerData: { code, dbPath, runId } })
  activeWorkers.set(runId, worker)

  worker.on('message', (msg: { type: string } & Record<string, unknown>) => {
    if (msg.type === 'log') {
      onLog({ level: msg.level as ScriptLog['level'], args: msg.args as string[], ts: msg.ts as number })
    } else if (msg.type === 'progress') {
      onProgress?.({ runId, value: msg.value as number, total: msg.total as number | undefined, label: msg.label as string | undefined })
    } else if (msg.type === 'done') {
      onComplete({ runId, durationMs: msg.durationMs as number })
    } else if (msg.type === 'error') {
      onComplete({ runId, durationMs: msg.durationMs as number, error: msg.message as string })
    } else if (msg.type === 'runExtract') {
      const { reqId, name } = msg as { type: string; reqId: string; name: string }
      if (!extractExecutor) {
        worker.postMessage({ type: 'runExtractError', reqId, error: 'Job executor not available' })
        return
      }
      extractExecutor(name)
        .then((result) => {
          if (result.status === 'error') {
            worker.postMessage({ type: 'runExtractError', reqId, error: result.errorMsg ?? 'Extract job failed' })
          } else if (result.status === 'cancelled') {
            worker.postMessage({ type: 'runExtractError', reqId, error: 'Extract job was cancelled' })
          } else {
            const rowsLoaded = result.rowsLoaded ?? 0
            worker.postMessage({
              type: 'runExtractResult', reqId, result: {
                status: result.status,
                rowsSource: rowsLoaded,
                rowsSucceeded: rowsLoaded,
              }
            })
          }
        })
        .catch((err: unknown) => {
          worker.postMessage({ type: 'runExtractError', reqId, error: err instanceof Error ? err.message : String(err) })
        })
    } else if (msg.type === 'runWriteback') {
      const { reqId, name } = msg as { type: string; reqId: string; name: string }
      if (!writebackExecutor) {
        worker.postMessage({ type: 'runWritebackError', reqId, error: 'Job executor not available' })
        return
      }
      writebackExecutor(name)
        .then((result) => {
          worker.postMessage({ type: 'runWritebackResult', reqId, result })
        })
        .catch((err: unknown) => {
          worker.postMessage({ type: 'runWritebackError', reqId, error: err instanceof Error ? err.message : String(err) })
        })
    } else if (msg.type === 'updateTableWithIds') {
      const { reqId, runId: jobRunId, sfKeyField, targetTable, tableKeyCol, idColumnName } =
        msg as { type: string; reqId: string; runId: string; sfKeyField: string; targetTable: string; tableKeyCol: string; idColumnName: string }
      if (!updateTableExecutor) {
        worker.postMessage({ type: 'updateTableWithIdsError', reqId, error: 'Job executor not available' })
        return
      }
      try {
        const result = updateTableExecutor(jobRunId, sfKeyField, targetTable, tableKeyCol, idColumnName)
        worker.postMessage({ type: 'updateTableWithIdsResult', reqId, result })
      } catch (err: unknown) {
        worker.postMessage({ type: 'updateTableWithIdsError', reqId, error: err instanceof Error ? err.message : String(err) })
      }
    } else if (msg.type === 'getFailedRows') {
      const { reqId, runId: jobRunId } = msg as { type: string; reqId: string; runId: string }
      if (!getFailedRowsExecutor) {
        worker.postMessage({ type: 'getFailedRowsError', reqId, error: 'Job executor not available' })
        return
      }
      try {
        const result = getFailedRowsExecutor(jobRunId)
        worker.postMessage({ type: 'getFailedRowsResult', reqId, result })
      } catch (err: unknown) {
        worker.postMessage({ type: 'getFailedRowsError', reqId, error: err instanceof Error ? err.message : String(err) })
      }
    } else if (msg.type === 'listJobs') {
      const { reqId } = msg as { type: string; reqId: string }
      if (!listJobsExecutor) {
        worker.postMessage({ type: 'listJobsError', reqId, error: 'Job executor not available' })
        return
      }
      try {
        const result = listJobsExecutor()
        worker.postMessage({ type: 'listJobsResult', reqId, result })
      } catch (err: unknown) {
        worker.postMessage({ type: 'listJobsError', reqId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })

  worker.on('error', (err) => {
    onComplete({ runId, durationMs: 0, error: err.message })
  })

  worker.on('exit', () => {
    activeWorkers.delete(runId)
  })
}

export function cancelScript(runId: string): void {
  const worker = activeWorkers.get(runId)
  if (worker) {
    worker.terminate()
    activeWorkers.delete(runId)
  }
}

const LLM_LOG_CAP = 200

/**
 * Run a JavaScript snippet in the restricted LLM worker.
 *
 * The worker uses vm.compileFunction() with a null-prototype context so that
 * only the explicitly provided db and console APIs are accessible. import()
 * calls and dangerous Node.js globals (process, fetch, etc.) are blocked.
 *
 * Returns a cancel function that terminates the worker immediately and
 * resolves the completion with a "Cancelled by user." error.
 * Log output is capped at LLM_LOG_CAP entries to prevent memory exhaustion.
 * There is no hard timeout — use the Cancel button in the UI to stop a long run.
 * The jobs API is intentionally not wired up.
 */
export function runLlmScript(
  dbPath: string,
  code: string,
  runId: string,
  onLog: (log: ScriptLog) => void,
  onComplete: (result: ScriptComplete) => void,
  onProgress?: (p: ScriptProgress) => void
): () => void {
  const workerPath = path.join(__dirname, 'script-runner-llm-worker.js')
  const worker = new Worker(workerPath, {
    workerData: { code, dbPath, runId },
    // Security is enforced inside the worker via vm.compileFunction() with a
    // null-prototype context that blocks import(), process, fetch, etc.
    // The Node.js permission-model flags (--allow-fs-read / --allow-fs-write)
    // are intentionally NOT used here: they would also block the worker from
    // loading its own module, Node.js built-ins, and the better-sqlite3 native
    // addon, causing a silent startup failure.
  })
  activeWorkers.set(runId, worker)

  let logCount = 0
  let completed = false

  const complete = (result: ScriptComplete): void => {
    if (completed) {
      return
    }
    completed = true
    onComplete(result)
  }

  worker.on('message', (msg: { type: string } & Record<string, unknown>) => {
    if (msg.type === 'log') {
      if (logCount < LLM_LOG_CAP) {
        logCount++
        onLog({ level: msg.level as ScriptLog['level'], args: msg.args as string[], ts: msg.ts as number })
      } else if (logCount === LLM_LOG_CAP) {
        logCount++
        onLog({ level: 'warn', args: [`[Output capped at ${LLM_LOG_CAP} lines]`], ts: Date.now() })
      }
    } else if (msg.type === 'progress') {
      onProgress?.({ runId, value: msg.value as number, total: msg.total as number | undefined, label: msg.label as string | undefined })
    } else if (msg.type === 'done') {
      complete({ runId, durationMs: msg.durationMs as number })
    } else if (msg.type === 'error') {
      complete({ runId, durationMs: msg.durationMs as number, error: msg.message as string })
    }
  })

  worker.on('error', (err) => {
    complete({ runId, durationMs: 0, error: err.message })
  })

  worker.on('exit', (code) => {
    activeWorkers.delete(runId)
    // If the worker exits without having sent a 'done' or 'error' message (e.g.
    // the permission model rejected the script, the worker module failed to load,
    // or an uncaught exception bypassed the message channel), resolve the promise
    // now so the UI doesn't stay stuck in "Executing…" forever.
    if (!completed) {
      complete({ runId, durationMs: 0, error: `Worker exited unexpectedly (exit code ${code ?? 'unknown'}).` })
    }
  })

  return (): void => {
    if (!completed) {
      worker.terminate()
      complete({ runId, durationMs: 0, error: 'Cancelled by user.' })
    }
  }
}
