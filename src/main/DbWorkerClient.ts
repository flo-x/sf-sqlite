import { Worker } from 'worker_threads'
import { join } from 'path'

type WorkerState = 'no-db' | 'idle' | 'busy'

type WorkerResponse =
  | { type: 'opened' }
  | { type: 'closed' }
  | { type: 'done'; id: string }
  | { type: 'error'; id?: string; message: string }

/**
 * Main-thread client for the db-worker.js Worker thread.
 *
 * The worker owns its own SQLite connection and runs long-blocking statements
 * (CREATE TABLE AS SELECT for writeback Phase 0) so the Node.js event loop on
 * the main thread stays free to serve IPC requests.
 *
 * State machine:
 *   no-db ──(openDb)──→ idle ──(runLoad)──→ busy
 *     ↑                   ↑                    │
 *     └──(closeDb)────────┘◄────(done/error)───┘
 *
 * Any request when state !== 'idle' is rejected immediately.
 * Cancellation terminates the worker thread and recreates it.
 */
class DbWorkerClient {
  private worker: Worker
  private _state: WorkerState = 'no-db'
  private _currentPath: string | null = null

  private openResolve?: () => void
  private openReject?: (e: Error) => void
  private closeResolve?: () => void
  private runResolve?: () => void
  private runReject?: (e: Error) => void

  constructor() {
    this.worker = this.spawnWorker()
  }

  private spawnWorker(): Worker {
    const w = new Worker(join(__dirname, 'db-worker.js'))
    w.on('message', (msg: WorkerResponse) => this.handleMessage(msg))
    w.on('error', (err) => {
      this._state = 'no-db'
      this.runReject?.(err)
      this.runResolve = undefined
      this.runReject = undefined
    })
    return w
  }

  private handleMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'opened':
        this._state = 'idle'
        this.openResolve?.()
        this.openResolve = undefined
        this.openReject = undefined
        break
      case 'closed':
        this._state = 'no-db'
        this.closeResolve?.()
        this.closeResolve = undefined
        break
      case 'done':
        this._state = 'idle'
        this.runResolve?.()
        this.runResolve = undefined
        this.runReject = undefined
        break
      case 'error':
        if (this.openReject) {
          const e = new Error(msg.message)
          this.openReject(e)
          this.openResolve = undefined
          this.openReject = undefined
        } else if (this.runReject) {
          this._state = 'idle'
          this.runReject(new Error(msg.message))
          this.runResolve = undefined
          this.runReject = undefined
        }
        break
    }
  }

  get state(): WorkerState {
    return this._state
  }

  /**
   * Tell the worker to open a new database.
   * This is fire-and-forget from the caller's perspective — openDb returns a
   * promise but callers can void it; the worker will be idle before any
   * writeback job starts.
   */
  openDb(path: string): Promise<void> {
    this._currentPath = path
    return new Promise((resolve, reject) => {
      this.openResolve = resolve
      this.openReject = reject
      this.worker.postMessage({ type: 'open', path })
    })
  }

  /** Tell the worker to close its database connection. Fire-and-forget. */
  closeDb(): void {
    this._currentPath = null
    this.worker.postMessage({ type: 'close' })
  }

  /**
   * Ask the worker to execute a single blocking SQL statement (typically a
   * CREATE TABLE AS SELECT for Phase 0 of a writeback run).
   *
   * Resolves when the statement completes. The caller is responsible for
   * querying any results (e.g. row count) from its own DB connection.
   * Rejects immediately if the worker is not idle.
   * Cancels by terminating and recreating the worker thread.
   */
  runLoad(opts: {
    id: string
    sql: string
    signal: AbortSignal
  }): Promise<void> {
    if (this._state !== 'idle') {
      return Promise.reject(new Error(`DB worker is "${this._state}" — cannot start load`))
    }
    if (opts.signal.aborted) {
      return Promise.reject(new DOMException('Cancelled by user', 'AbortError'))
    }

    this._state = 'busy'
    return new Promise((resolve, reject) => {
      this.runResolve = resolve
      this.runReject = reject

      const abortHandler = (): void => {
        const savedReject = this.runReject
        this.runResolve = undefined
        this.runReject = undefined
        // Terminate the worker (the blocking statement cannot be interrupted)
        // then recreate it and re-open the database.
        this.worker.terminate().then(() => {
          this.worker = this.spawnWorker()
          this._state = 'no-db'
          if (this._currentPath) {
            void this.openDb(this._currentPath)
          }
          savedReject?.(new DOMException('Cancelled by user', 'AbortError'))
        }).catch(() => {
          savedReject?.(new DOMException('Cancelled by user', 'AbortError'))
        })
      }

      opts.signal.addEventListener('abort', abortHandler, { once: true })
      this.worker.postMessage({ type: 'run', id: opts.id, sql: opts.sql })
    })
  }

  /** Terminate the worker (called on app quit). */
  terminate(): Promise<number> {
    return this.worker.terminate()
  }
}

export const dbWorker = new DbWorkerClient()
